#!/usr/bin/env node
// tools/ledger-admin.mjs: owner-only ledger operations (ARCHITECTURE §6.2, §6.8, §10, §15.4; INTERFACES
// "Owner-only ops live in tools/ledger-admin.mjs (createGenesis, policy, owner, allow)"; v0.3: the
// freeze-group ops, V03-DESIGN-REVIEW 2.5.3, 2.5.5, 2.8.7, 2.10.1; MF-20, MF-22, MF-27 to MF-29).
//
// The owner's private key never enters a browser. The owner mints the genesis policy block here
// (tools/publish.mjs calls createGenesis and puts gen=<h> into the signed pointer) and appends
// later control blocks to a ledger export file: a JSON array of blocks, as exported from a node
// (Settings, Export ledger JSON), or genesis.json from publish. Visitors receive the new blocks
// through the snapshot named by the pointer's cs= (tools/snapshot.mjs) and then by gossip. Everything
// here is offline: no command opens a socket.
//
//   node tools/ledger-admin.mjs genesis  --key owner.jwk --scope <host> [--chain <label>] [policy flags] --out genesis.json
//   node tools/ledger-admin.mjs policy   --key owner.jwk --file ledger.json [--writers owner|allow|open] [--bits n]
//                                        [--max-value-bytes n] [--max-chain-bytes n] [--moderator <pub>]... [--clear-moderators]
//                                        [--allow <pub>]... [--clear-allow] [--mod-allow-per-day n] [--mod-actions-per-hour n]
//                                        [--reserved-pool n] [--void <author>@<h>]... [--clear-voided]
//   node tools/ledger-admin.mjs owner    --key owner.jwk --file ledger.json --next <pub> [--accept-key new-owner.jwk]
//   node tools/ledger-admin.mjs accept   --key new-owner.jwk --file ledger.json --after <h of the hand-over to this key>
//   node tools/ledger-admin.mjs allow    --key owner.jwk --file ledger.json [--add <pub>]... [--remove <pub>]...
//   node tools/ledger-admin.mjs ban      --key owner.jwk --file ledger.json --author <pub> [--until <ms|ISO date>]
//   node tools/ledger-admin.mjs unban    --key owner.jwk --file ledger.json --author <pub>
//   node tools/ledger-admin.mjs tombstone --key owner.jwk --file ledger.json --h <block hash>
//   node tools/ledger-admin.mjs tombstone --key owner.jwk --file ledger.json --authors <pub>[,<pub>]... --before <block hash>
//   node tools/ledger-admin.mjs keyinfo  --key member.jwk --file ledger.json (--recover-key recover.jwk | --recover-pub <pub>)
//   node tools/ledger-admin.mjs rotate   --by self    --key old.jwk --file ledger.json (--next <pub> | --next-key new.jwk)
//   node tools/ledger-admin.mjs rotate   --by recover --key new.jwk --file ledger.json --from <old pub> --recover-key recover.jwk
//   node tools/ledger-admin.mjs checkpoint --key owner.jwk --file ledger.json [--out checkpoint-state.json] [--heads <h>[,<h>]...]
//   node tools/ledger-admin.mjs cfg      --key owner.jwk --file ledger.json [--chat ...] [--files ...] [--media ...] [--calls ...] [--records ...] ...
//   node tools/ledger-admin.mjs deny     --key owner.jwk --file ledger.json (--ih <40 hex> | --sha256 <64 hex>) --reason <code> [--ref <text>]
//   node tools/ledger-admin.mjs listed   --key owner.jwk --file ledger.json --ih <40 hex>   (accept a public listing that waits for a moderator)
//   node tools/ledger-admin.mjs capacity [--members n --items n] [--file ledger.json] [--max-chain-bytes n]
//   node tools/ledger-admin.mjs show     --file ledger.json

import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';

import {
  createBlock, validateBlock, validatePolicyFields, rotateSigningInput, selfRotateSigningInput, DEFAULT_POLICY, LIMITS, FREEZE_LIMITS,
} from '../src/chain/block.js';
import { Dag } from '../src/chain/dag.js';
import {
  reduce, admit, ownerAfter, ownerStanding, snapshot as stateSnapshot, checkpointFor, checkpointSnap, reduceFromCheckpoint, schemaOk, CFG_TIERS,
} from '../src/chain/state.js';
import { isPublicKeyString, fingerprint, keyAlgorithm, P256_PREFIX, sha256, sign } from '../src/chain/crypto.js';
import { canonicalize, b64url, utf8 } from '../src/chain/canonical.js';
import { ledgerIdFor, normalizeScope } from '../src/common/pointer.js';
// v0.3 C2 doors (docs/research/v03/S4-doors.md D5): the owner's _doors item, written with the owner key.
import { ledgerDoorsValue, LEDGER_DOORS_KEY } from '../src/loader/doors.js';
import {
  parseCli, runMain, isMain, loadOwnerKey, writeFileAtomic, ToolError, UsageError, out, warn,
} from './lib.mjs';

const USAGE = `
Usage: node tools/ledger-admin.mjs <command> [options]

Commands (a key file is required except for show and capacity; owner-only ones are marked):
  genesis    --key owner.jwk --scope <host> [--chain <label>] [policy flags] --out <file> [--force]
  policy     --key owner.jwk --file <ledger.json> [policy flags]                          (owner)
  owner      --key owner.jwk --file <ledger.json> --next <pub> [--accept-key <new owner's key file>]   (owner)
  accept     --key <new owner's key file> --file <ledger.json> --after <h of the hand-over to this key>
  allow      --key owner.jwk --file <ledger.json> [--add <pub>]... [--remove <pub>]...    (owner; a moderator may add)
  ban        --key owner.jwk --file <ledger.json> --author <pub> [--until <ms | ISO 8601 date>]
  unban      --key owner.jwk --file <ledger.json> --author <pub>
  tombstone  --key owner.jwk --file <ledger.json> --h <block hash>
  tombstone  --key owner.jwk --file <ledger.json> --authors <pub>[,<pub>]... --before <block hash>   (bulk, at most 64 authors)
  keyinfo    --key <member key> --file <ledger.json> (--recover-key <recover key file> | --recover-pub <pub>)
  rotate     --by self    --key <old key> --file <ledger.json> (--next <pub> | --next-key <new key file>)
  rotate     --by recover --key <new key> --file <ledger.json> --from <old pub> --recover-key <recover key file>
  checkpoint --key owner.jwk --file <ledger.json> [--out <state file>] [--heads <h>[,<h>]...]   (owner)
  cfg        --key owner.jwk --file <ledger.json> [settings] | --show                       (owner or moderator)
  deny       --key owner.jwk --file <ledger.json> (--ih <40 hex> | --sha256 <64 hex>) --reason P0|illegal|malware|spam|other [--ref <text>]
  listed     --key owner.jwk --file <ledger.json> --ih <40 hex> [--author <key>]   (owner or moderator: accept a new key's public listing, premoderation)
  doors      --key owner.jwk --file <ledger.json> --door <host>... | --clear-doors | --show   (owner only: readers hide a moderator's)
  capacity   [--members <n> --items <n>] [--file <ledger.json>] [--max-chain-bytes <n>]
  show       --file <ledger.json> [--genesis-owner <pub>]

Policy flags: --writers owner|allow|open (alias --policy), --bits <n>, --max-value-bytes <n>,
  --max-chain-bytes <n>, --moderator <pub>... (or --clear-moderators), --allow <pub>... (or --clear-allow),
  --mod-allow-per-day <n> (default 20 when unset), --mod-actions-per-hour <n> (60), --reserved-pool <0 to 50 percent> (25),
  --void <author>@<h>... (a removed moderator's control blocks that are not in the past of <h> have no effect; at most 50) or --clear-voided

cfg settings (the _mw.cfg key, advisory: honest loaders enforce it, nothing security-relevant is stored there):
  --chat off|members|open            --files off|members              --media off|members
  --calls off|contacts               (audio and video calls between signed-in contacts; needs chat on and the site's own tracker and STUN)
  --records off|sealed [--max-items 1..32]                --requests off|on|introduced [--chat-bits 0..32]
                                     (introduced takes no message requests in 0.3.0: introductions are not built)
  --pin <node key> | none            --age none|<verifier key>
  --turn <url>... [--turn-mode static|endpoint]   (turn:, turns: or https: URLs, at most 8)
  --wall everyone|follow|nobody|approve           (who may post on a person's wall: the social template)
  --block-tiers <kind>[,<kind>]... | none        (file kinds readers refuse to save: ${CFG_TIERS.join(', ')})
  --clear <name>...   removes a setting (chat, files, media, calls, records, maxItems, requests, chatBits, pin, turn, age, wall, blockTiers)
  Settings you do not pass keep their value; the whole object is written as one put.

A ledger file is a JSON array of blocks (an export from a node, genesis.json from publish, or a
gzip of either). New blocks are appended to it; publish it for visitors with tools/snapshot.mjs.

A hand-over (owner) revokes the old key: whatever it signs beside or after the hand-over has no
owner standing. If the old key ever signs a second hand-over, visitors follow the one the new
owner endorsed: a block signed by the pointer's owner key with that hand-over in its past. Give
--accept-key to write that endorsement at once (an empty policy block by the new key), or run
"accept" with the new key later.

keyinfo publishes the commitment to a recover key: rc = base64url(sha256(utf8(recover public key))). The first
keyinfo of a key wins and cannot be redacted. rotate --by recover is signed by the NEW key and carries the
recover key's signature (rsig) over "mw-rotate-v1" + ledger id + from + next; a recover rotation beats a
self rotation of the same key in any order. A rotation passes bans and allow-list membership to the new key,
never moderator or owner standing (use "owner" to hand the ledger over). rotate --by self passes them only
with the new key's consent: give --next-key so the new key signs it (nsig over "mw-rotate-self-v1" + ledger
id + from + next); with --next alone the old key is retired and nothing moves to the new key.
`;

const POLICY_OPS = new Set(['policy', 'owner', 'allow', 'checkpoint']);

/** The accounted ledger cost of one sealed item at one parent (R 2.6.2, measured by judge DS), in bytes. */
export const SEALED_ITEM_BYTES = 1877;

/**
 * keyHint(p) → why `p` is not a public key, in words (v0.2.1, DIGEST-AMENDMENTS A2: keys are
 * written 'p256:' + 87 base64url characters; untagged v0.2 keys are refused, with a hint).
 */
export function keyHint(p) {
  if (typeof p !== 'string') return 'not a public key';
  const alg = keyAlgorithm(p);
  if (alg === null && /^[A-Za-z0-9_-]{87}$/.test(p)) return 'public keys are algorithm-tagged since v0.2.1: write ' + P256_PREFIX + p.slice(0, 8) + '...';
  if (alg !== null && alg !== 'p256') return 'unsupported key type: ' + alg;
  return 'not a P-256 public key (' + P256_PREFIX + ' followed by 87 base64url characters)';
}

// ---------------------------------------------------------------------------------------------
// policy
// ---------------------------------------------------------------------------------------------

function sortedUnique(list) {
  return Array.from(new Set(list)).sort();
}

const V1_FIELDS = ['writers', 'bits', 'maxValueBytes', 'maxChainBytes', 'moderators', 'allow'];
const FREEZE_FIELDS = ['modAllowPerDay', 'modActionsPerHour', 'reservedPool', 'voided'];

/**
 * policyOp(partial, { full }) → { t: 'policy', ... } with moderators/allow sorted and unique and voided sorted by author.
 * full: every v1 field present, defaults from DEFAULT_POLICY (the genesis states the whole v1 policy). The freeze-group
 * fields (modAllowPerDay, modActionsPerHour, reservedPool, voided; R 2.5.3) are written only when given: a reader that
 * finds none uses the documented defaults (20, 60, 25 percent, none).
 * Throws ToolError for invalid fields (validatePolicyFields).
 */
export function policyOp(partial = {}, { full = false } = {}) {
  const src = partial || {};
  const op = { t: 'policy' };
  for (const f of V1_FIELDS) {
    let v = src[f];
    if (v === undefined || v === null) {
      if (!full) continue;
      v = DEFAULT_POLICY[f];
    }
    if (f === 'moderators' || f === 'allow') {
      if (!Array.isArray(v)) throw new ToolError(f + ' must be a list of public keys');
      for (const p of v) if (!isPublicKeyString(p)) throw new ToolError(keyHint(p) + ': ' + p);
      v = sortedUnique(v);
    }
    op[f] = v;
  }
  for (const f of FREEZE_FIELDS) {
    let v = src[f];
    if (v === undefined || v === null) continue;
    if (f === 'voided') {
      if (!Array.isArray(v)) throw new ToolError('voided must be a list of { author, after }');
      for (const x of v) if (!x || !isPublicKeyString(x.author)) throw new ToolError('voided: ' + keyHint(x && x.author) + ': ' + (x && x.author));
      v = v.map((x) => ({ author: x.author, after: x.after })).sort((a, b) => (a.author < b.author ? -1 : a.author > b.author ? 1 : 0));
    }
    op[f] = v;
  }
  const check = validatePolicyFields(op);
  if (!check.ok) throw new ToolError('invalid policy field ' + (check.field || '') + ' (' + check.reason + ')');
  return op;
}

/** `<author>@<h>` → { author, after } for --void. */
export function parseVoid(text) {
  const at = String(text).lastIndexOf('@');
  const author = at > 0 ? text.slice(0, at) : '';
  const after = at > 0 ? text.slice(at + 1) : '';
  if (!isPublicKeyString(author)) throw new UsageError('--void takes <author>@<64 hex block hash>; ' + keyHint(author));
  if (!/^[0-9a-f]{64}$/.test(after)) throw new UsageError('--void takes <author>@<64 hex block hash>, got a hash of the wrong shape: ' + after);
  return { author, after };
}

/** The policy flags of a parsed command line → partial policy (only the flags that were given). */
export function policyFromFlags(flags) {
  const p = {};
  const writers = flags.writers || flags.policy || null;
  if (writers) {
    if (!['owner', 'allow', 'open'].includes(writers)) throw new UsageError('--writers must be owner, allow or open');
    p.writers = writers;
  }
  if (flags.bits !== null && flags.bits !== undefined) p.bits = flags.bits;
  if (flags.maxValueBytes !== null && flags.maxValueBytes !== undefined) p.maxValueBytes = flags.maxValueBytes;
  if (flags.maxChainBytes !== null && flags.maxChainBytes !== undefined) p.maxChainBytes = flags.maxChainBytes;
  if (flags.clearModerators) p.moderators = [];
  else if (flags.moderator && flags.moderator.length) p.moderators = flags.moderator.slice();
  if (flags.clearAllow) p.allow = [];
  else if (flags.allow && flags.allow.length) p.allow = flags.allow.slice();
  if (flags.modAllowPerDay !== null && flags.modAllowPerDay !== undefined) p.modAllowPerDay = flags.modAllowPerDay;
  if (flags.modActionsPerHour !== null && flags.modActionsPerHour !== undefined) p.modActionsPerHour = flags.modActionsPerHour;
  if (flags.reservedPool !== null && flags.reservedPool !== undefined) p.reservedPool = flags.reservedPool;
  if (flags.clearVoided) p.voided = [];
  else if (flags.void && flags.void.length) p.voided = flags.void.map(parseVoid);
  return p;
}

// ---------------------------------------------------------------------------------------------
// genesis
// ---------------------------------------------------------------------------------------------

/**
 * createGenesis({ identity: { privateKey, pub }, ledgerId, policy = {}, now = Date.now() }) → Block
 * The owner's root: a { t: 'policy' } block with prev [] and every v1 policy field stated (freeze-group
 * fields only when given), authored and signed by the owner key, bits 0 (the owner is exempt from
 * proof-of-work). Its h goes into the pointer as gen=.
 */
export async function createGenesis({ identity, ledgerId, policy = {}, now = Date.now() } = {}) {
  if (!identity || !identity.privateKey || !isPublicKeyString(identity.pub)) throw new TypeError('createGenesis needs identity { privateKey, pub }');
  if (typeof ledgerId !== 'string' || !ledgerId.startsWith('mw1:')) throw new TypeError('createGenesis needs a signed ledger id (mw1:...)');
  const op = policyOp(policy, { full: true });
  return createBlock({ identity, site: ledgerId, seq: 0, prev: [], op, ts: now, bits: 0 });
}

/** The ledger id a signed pointer with this owner, chain and scope has (ARCHITECTURE §4). */
export function ledgerIdForOwner(pub, { scope, chain = null }) {
  return ledgerIdFor({ sig: 'pending', owner: pub, chain: chain || null }, chain ? 'btih:' + '0'.repeat(40) : normalizeScope(scope));
}

/** Checks that `block` is a genesis policy block of `ledgerId` by `owner`. → { ok, reason } */
export async function checkGenesis(block, { ledgerId = null, owner = null } = {}) {
  if (!block || !block.e) return { ok: false, reason: 'not a block' };
  const e = block.e;
  if (!Array.isArray(e.prev) || e.prev.length !== 0) return { ok: false, reason: 'not a root (prev is not empty)' };
  if (!e.op || e.op.t !== 'policy') return { ok: false, reason: 'not a policy block' };
  if (owner && e.author !== owner) return { ok: false, reason: 'authored by another key' };
  if (ledgerId && e.site !== ledgerId) return { ok: false, reason: 'belongs to ledger ' + e.site };
  const v = await validateBlock(block, { minBits: 0, genesisOwner: owner || e.author, site: ledgerId || undefined });
  return v.ok ? { ok: true, reason: null } : { ok: false, reason: 'invalid block (' + v.reason + ')' };
}

// ---------------------------------------------------------------------------------------------
// ledger files
// ---------------------------------------------------------------------------------------------

/** Reads a ledger file: a JSON array of blocks or one block, optionally gzip-compressed. */
export function readBlocksFile(file) {
  let bytes = readFileSync(file);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (err) {
    throw new ToolError(file + ' is not JSON: ' + err.message);
  }
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && Array.isArray(value.blocks)) return value.blocks;
  if (value && typeof value === 'object' && value.e && value.h) return [value];
  throw new ToolError(file + ' is not a ledger export (expected a JSON array of blocks)');
}

/** One block per line inside a JSON array: valid JSON, readable diffs. */
export function formatBlocks(blocks) {
  if (!blocks.length) return '[]\n';
  return '[\n' + blocks.map((b) => JSON.stringify(b)).join(',\n') + '\n]\n';
}

/**
 * writeBlocksFile(file, blocks, { gzip }) writes one block per line; gzip: true compresses the file (post-wave
 * fix Q: ledger-admin keeps a gzip ledger file gzip instead of writing plain JSON under its .json.gz name).
 */
export function writeBlocksFile(file, blocks, { gzip = false } = {}) {
  const text = formatBlocks(blocks);
  writeFileAtomic(file, gzip ? gzipSync(Buffer.from(text, 'utf8'), { level: 9 }) : text);
}

/** isGzipFile(file) → true when the file starts with the gzip magic bytes (1f 8b). */
export function isGzipFile(file) {
  try {
    const bytes = readFileSync(file);
    return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  } catch (_) {
    return false;
  }
}

/** The author of the ledger's genesis: the single author of root policy blocks (or of `gen`). */
export function genesisOwnerOf(dag, { gen = null } = {}) {
  if (gen) {
    const b = dag.get(gen);
    if (!b) throw new ToolError('the genesis block ' + gen + ' is not in the ledger file');
    return b.e.author;
  }
  const authors = new Set();
  for (const b of dag.order()) {
    if (b.e.prev.length === 0 && b.e.op && b.e.op.t === 'policy') authors.add(b.e.author);
  }
  if (authors.size === 1) return authors.values().next().value;
  if (authors.size === 0) return null;
  throw new ToolError('the ledger has root policy blocks by ' + authors.size + ' keys; pass --genesis-owner <pub>');
}

/** The first entry of a pruned ledger's export (ChainNode.exportSnapshot, a cs= file of a pruned copy) or of a recent window. */
const CHECKPOINT_HEADERS = new Set(['checkpoint-v1', 'recent-v1']);
function exportHeader(x) {
  return x && typeof x === 'object' && !Array.isArray(x) && !x.e && CHECKPOINT_HEADERS.has(x.mw) ? x : null;
}

/**
 * loadLedger(blocks, { genesisOwner, gen, expectedOwner, checkpoint }) → { dag, genesisOwner, site, state, invalid, orphans,
 * checkpoint }. Every block is validated (h, signature, proof-of-work as declared, value hash); invalid blocks are reported in
 * `invalid` and left out. A pruned ledger (code review v0.3: every copy prunes to an owner checkpoint) comes with its checkpoint
 * { h, snap, S, depths? }: as the export's first entry ({ mw: 'checkpoint-v1', checkpoint }) or as the option; the DAG starts
 * from S (the checkpoint block must be in the file, S must match it) and the genesis owner defaults to S's first owner key.
 */
export async function loadLedger(blocks, { genesisOwner = null, gen = null, expectedOwner = null, checkpoint = null } = {}) {
  const dag = new Dag({ maxOrphans: Infinity, maxOrphansPerPeer: Infinity });
  const invalid = [];
  let site = null;
  let list = Array.isArray(blocks) ? blocks : [];
  const head = list.length > 0 ? exportHeader(list[0]) : null;
  if (head) list = list.slice(1);
  const cp = checkpoint || (head && head.checkpoint && typeof head.checkpoint === 'object' ? head.checkpoint : null);
  let base = null;
  if (cp && cp.S && typeof cp.h === 'string') {
    const block = list.find((b) => b && b.h === cp.h);
    if (!block) throw new ToolError('the checkpoint block ' + cp.h + ' is not in the ledger file');
    const v = await validateBlock(block, { minBits: 0, maxValueBytes: LIMITS.maxBlockBytes });
    if (!v.ok) throw new ToolError('the checkpoint block is invalid (' + v.reason + ')');
    try {
      dag.pruneTo(block, cp.S, { depths: cp.depths || null });
    } catch (err) {
      throw new ToolError('the checkpoint state does not match its block (' + err.message + ')');
    }
    const keys = cp.S.state && cp.S.state.owner && Array.isArray(cp.S.state.owner.keys) ? cp.S.state.owner.keys : [];
    if (keys.length === 0 || block.e.author !== keys[keys.length - 1]) throw new ToolError('the checkpoint is not signed by the owner its state names');
    if (!genesisOwner) genesisOwner = keys[0];
    base = { h: block.h, snap: block.e.op.snap, S: cp.S };
  }
  for (const b of list) {
    if (base && (dag.has(b && b.h) || dag.isCovered(b && b.h))) continue;
    const v = await validateBlock(b, { minBits: 0, maxValueBytes: LIMITS.maxBlockBytes });
    if (!v.ok) {
      invalid.push({ h: b && b.h, reason: v.reason });
      continue;
    }
    if (site === null) site = b.e.site;
    if (b.e.site !== site) {
      invalid.push({ h: b.h, reason: 'another ledger (' + b.e.site + ')' });
      continue;
    }
    dag.add(b, 'file');
  }
  const owner = genesisOwner || genesisOwnerOf(dag, { gen });
  const state = reduce(dag, { genesisOwner: owner, expectedOwner });
  return { dag, genesisOwner: owner, expectedOwner, site, state, invalid, orphans: dag.orphanCount, checkpoint: base };
}

// What a refusal at ingest means for the person holding the key (state.admit codes, freeze group included).
function refusalHint(verdict, op) {
  const key = verdict.code + '/' + verdict.reason;
  const hints = {
    'E_POLICY/keyinfo-set': 'this key already published a keyinfo; the first one per key wins and cannot be changed',
    'E_POLICY/recover': 'the recover key does not match the commitment (keyinfo rc) that ' + (op && op.from ? op.from.slice(0, 14) + '...' : 'the old key') + ' published; publish a keyinfo for it first',
    'E_POLICY/bits': 'this key must meet the ledger\'s posting fee (policy bits); it is not the owner or a moderator',
    'E_POLICY/writers': 'this ledger\'s policy does not let this key write',
    'E_POLICY/allow': 'this key is not on the ledger\'s allow list',
    'E_POLICY/owner-protected': 'a moderator cannot remove what the owner wrote',
    'E_NOT_OWNER/owner-only': 'only the owner key may write this',
    'E_NOT_MODERATOR/moderator-only': 'only the owner or a moderator may write this',
    'E_NOT_MODERATOR/underscore': 'keys and lists that start with "_" are written by the owner or a moderator only',
  };
  return hints[key] ? ' - ' + hints[key] : '';
}

/**
 * appendControl({ blocks, identity, op, value, now, genesisOwner, gen, prev, ensureInPast, bits }) → { block, blocks }
 * Builds the next block on top of the ledger: prev = the author's own last block, the deepest head, then the oldest
 * heads (at most 8, DESIGN-REVIEW S9), signed by `identity`. The proof-of-work is 0 for the owner and for moderators
 * and the ledger's posting fee (policy bits) for any other key, which the tool mines. `value` is for the payload ops
 * (put, append, profile). `ensureInPast` lists blocks that must be in the new block's causal past (a bulk tombstone's
 * `before`). Refuses (ToolError) when the key is not the owner in effect (policy, owner, allow, checkpoint) or when the
 * block would be refused at ingest (state.admit).
 */
export async function appendControl({ blocks, identity, op, value, now = Date.now(), genesisOwner = null, gen = null, expectedOwner = null, prev: fixedPrev = null, ensureInPast = [], bits = null } = {}) {
  const led = await loadLedger(blocks, { genesisOwner, gen, expectedOwner });
  if (led.invalid.length) throw new ToolError(led.invalid.length + ' invalid block(s) in the ledger file (first: ' + led.invalid[0].reason + '); fix the file first');
  if (led.orphans) throw new ToolError('the ledger file is missing parents of ' + led.orphans + ' block(s); export the whole ledger');
  if (!led.site) throw new ToolError('the ledger file has no blocks; start from genesis.json');
  if (!led.genesisOwner) throw new ToolError('the ledger has no genesis policy block; it is unmoderated and has no owner');
  const order = led.dag.order();
  let own = null;
  let ownCount = 0;
  for (const b of order) {
    if (b.e.author === identity.pub) {
      own = b;
      ownCount++;
    }
  }
  const heads = led.dag.heads({ limit: Infinity });
  let prev = [];
  const push = (h) => {
    if (h && prev.indexOf(h) < 0 && prev.length < LIMITS.maxPrev) prev.push(h);
  };
  if (Array.isArray(fixedPrev)) {
    for (const h of fixedPrev) {
      if (!led.dag.has(h)) throw new ToolError('block ' + h + ' is not in the ledger file');
      push(h);
    }
  } else {
    if (own) push(own.h);
    push(heads[0]);
    for (let i = heads.length - 1; i >= 1; i--) push(heads[i]);
  }
  for (const h of ensureInPast) {
    if (!led.dag.has(h)) throw new ToolError('block ' + h + ' is not in the ledger file');
    if (prev.some((p) => p === h || led.dag.ancestors(p).has(h))) continue;
    if (prev.length >= LIMITS.maxPrev) throw new ToolError('block ' + h + ' is not in the past of the new block and there is no room for another parent (at most ' + LIMITS.maxPrev + ')');
    prev.push(h);
  }
  prev = prev.sort();
  const ownerNow = ownerAfter(led.dag, prev, led.genesisOwner, expectedOwner);
  const standing = ownerStanding(led.state, { e: { author: identity.pub, prev } }, { dag: led.dag, expectedOwner });
  if (POLICY_OPS.has(op.t) && !standing) {
    if (led.state.ownerConflict) {
      throw new ToolError('the ledger holds two hand-overs signed by ' + (await fingerprint(led.state.owner)) +
        ' and neither is endorsed: owner changes are paused until the pointer\'s owner key runs "accept --after <h>" for its hand-over');
    }
    throw new ToolError('this key (' + (await fingerprint(identity.pub)) + ') is not the owner of the ledger in effect (' +
      (led.state.owner ? await fingerprint(led.state.owner) : ownerNow ? await fingerprint(ownerNow) : 'none') + ')');
  }
  const privileged = standing || led.state.policy.moderators.has(identity.pub);
  const powBits = bits !== null && bits !== undefined ? bits : (privileged ? 0 : led.state.policy.bits);
  const block = await createBlock({ identity, site: led.site, seq: ownCount, prev, op, value, ts: now, bits: powBits });
  const verdict = admit(led.state, block, { dag: led.dag, genesisOwner: led.genesisOwner, expectedOwner });
  if (!verdict.ok) throw new ToolError('the new block would be refused (' + verdict.code + ', ' + verdict.reason + ')' + refusalHint(verdict, op));
  return { block, blocks: blocks.concat([block]), ledger: led };
}

// ---------------------------------------------------------------------------------------------
// the owner-only ops as functions (INTERFACES: createGenesis, policy, owner, allow)
// ---------------------------------------------------------------------------------------------

/** setPolicy({ blocks, identity, policy: { writers, bits, ... }, now }) → { block, blocks } (exported as `policy`) */
export async function setPolicy({ policy: fields, ...rest } = {}) {
  return appendControl({ ...rest, op: policyOp(fields) });
}

/** setOwner({ blocks, identity, next, now }) → { block, blocks } (exported as `owner`): hands the ledger to `next` */
export async function setOwner({ next, ...rest } = {}) {
  if (!isPublicKeyString(next)) throw new ToolError('owner needs the public key of the new owner (' + keyHint(next) + ')');
  return appendControl({ ...rest, op: { t: 'owner', next } });
}

/** setAllow({ blocks, identity, add, remove, now }) → { block, blocks } (exported as `allow`): edits the allow list */
export async function setAllow({ add = [], remove = [], ...rest } = {}) {
  for (const p of add.concat(remove)) if (!isPublicKeyString(p)) throw new ToolError(keyHint(p) + ': ' + p);
  if (!add.length && !remove.length) throw new ToolError('allow needs keys to add or remove');
  const op = { t: 'allow' };
  if (add.length) op.add = sortedUnique(add);
  if (remove.length) op.remove = sortedUnique(remove);
  return appendControl({ ...rest, op });
}

/**
 * acceptHandover({ blocks, identity, after, now }) → { block, blocks }: the new owner's endorsement
 * of the hand-over `after` (a { t:'owner', next: identity.pub } block): an empty policy block
 * signed by the new key with `after` as its only parent. Visitors whose pointer names this key
 * follow the endorsed hand-over when the old key signed another one (state.js).
 */
export async function acceptHandover({ blocks, identity, after, now = Date.now(), genesisOwner = null, gen = null } = {}) {
  const led = await loadLedger(blocks, { genesisOwner, gen, expectedOwner: identity.pub });
  const target = led.dag.get(after);
  if (!target) throw new ToolError('block ' + after + ' is not in the ledger file');
  if (!target.e.op || target.e.op.t !== 'owner' || target.e.op.next !== identity.pub) {
    throw new ToolError('block ' + after + ' is not a hand-over to this key (' + (await fingerprint(identity.pub)) + ')');
  }
  return appendControl({ blocks, identity, op: { t: 'policy' }, now, genesisOwner, gen, expectedOwner: identity.pub, prev: [after] });
}

export { setPolicy as policy, setOwner as owner, setAllow as allow, acceptHandover as accept };

// ---------------------------------------------------------------------------------------------
// v0.3 ops: ban --until, unban, bulk tombstone, keyinfo, rotate, checkpoint (R 2.5.3)
// ---------------------------------------------------------------------------------------------

const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
/** Milliseconds below this are not a plausible --until (it is January 1973 or earlier): the person probably typed seconds. */
const UNTIL_FLOOR_MS = 100000000000;

/**
 * parseUntil(value) → ms since 1970: whole milliseconds, or an ISO 8601 date or date-time (a date alone is midnight UTC).
 * UsageError for anything else, and for a number that cannot be milliseconds.
 */
export function parseUntil(value) {
  const s = String(value === undefined || value === null ? '' : value).trim();
  let ms;
  if (/^\d+$/.test(s)) {
    ms = Number(s);
    if (!Number.isSafeInteger(ms)) throw new UsageError('--until is too large');
    if (ms < UNTIL_FLOOR_MS) throw new UsageError('--until ' + s + ' is in January 1973 or earlier: it takes milliseconds since 1970 (or an ISO 8601 date such as 2026-12-01)');
    return ms;
  }
  ms = Date.parse(s);
  if (!Number.isFinite(ms)) throw new UsageError('--until must be milliseconds since 1970 or an ISO 8601 date such as 2026-12-01 or 2026-12-01T09:00:00Z');
  return ms;
}

/** banOp({ author, until }) → { t: 'ban', author[, until] } (until: the ban governs blocks with ts < until; absent means permanent). */
export function banOp({ author, until } = {}) {
  if (!isPublicKeyString(author)) throw new ToolError('ban needs --author <public key> (' + keyHint(author) + ')');
  const op = { t: 'ban', author };
  if (until !== undefined && until !== null) {
    if (!Number.isSafeInteger(until) || until < 0) throw new ToolError('ban --until must be milliseconds since 1970');
    op.until = until;
  }
  return op;
}

/** unbanOp({ author }) → { t: 'unban', author } (R 2.5.3: the owner lifts any ban; a moderator only bans a moderator made). */
export function unbanOp({ author } = {}) {
  if (!isPublicKeyString(author)) throw new ToolError('unban needs --author <public key> (' + keyHint(author) + ')');
  return { t: 'unban', author };
}

/** bulkTombstoneOp({ authors, before }) → { t: 'tombstone', authors (sorted, unique, at most 64), before } */
export function bulkTombstoneOp({ authors, before } = {}) {
  const list = sortedUnique(Array.isArray(authors) ? authors : []);
  if (!list.length) throw new ToolError('a bulk tombstone needs --authors <public key>[,<public key>]...');
  if (list.length > FREEZE_LIMITS.maxBulkAuthors) throw new ToolError('a bulk tombstone names at most ' + FREEZE_LIMITS.maxBulkAuthors + ' authors, got ' + list.length);
  for (const p of list) if (!isPublicKeyString(p)) throw new ToolError(keyHint(p) + ': ' + p);
  if (!HEX64.test(String(before || ''))) throw new ToolError('a bulk tombstone needs --before <64 hex block hash>: it hides every payload of those authors that is not after that block');
  return { t: 'tombstone', authors: list, before };
}

/**
 * recoveryCommitment(recoverPub) → rc: base64url(sha256(utf8(the tagged recover public key))), 43 characters. This is the
 * value of keyinfo.rc, and a recover rotation's rp must hash to it (src/chain/state.js).
 */
export async function recoveryCommitment(recoverPub) {
  if (!isPublicKeyString(recoverPub)) throw new ToolError('the recover public key is not valid (' + keyHint(recoverPub) + ')');
  return b64url.encode(await sha256(utf8.encode(recoverPub)));
}

/** keyinfoOp({ recoverPub }) → { t: 'keyinfo', rc } */
export async function keyinfoOp({ recoverPub } = {}) {
  return { t: 'keyinfo', rc: await recoveryCommitment(recoverPub) };
}

/**
 * rotateOp({ by, from, next, ledgerId, recover: { privateKey, pub }, nextKey: { privateKey, pub } }) → the rotate op.
 * by 'self': { t, from, next, by }, authored by `from`; with nextKey (the new key, review round HUB-1) it adds nsig, the
 * new key's ECDSA signature over selfRotateSigningInput(ledgerId, from, next), without which the rotation retires `from`
 * but moves neither bans nor allow membership to `next`. by 'recover': { t, from, next, by, rp, rsig }, authored by `next`;
 * rsig is the recover key's ECDSA signature over rotateSigningInput(ledgerId, from, next), i.e. "mw-rotate-v1\n" + ledgerId
 * + "\n" + from + "\n" + next, as base64url of the raw 64 bytes.
 */
export async function rotateOp({ by, from, next, ledgerId, recover = null, nextKey = null } = {}) {
  if (!isPublicKeyString(from)) throw new ToolError('rotate needs the old public key (' + keyHint(from) + ')');
  if (!isPublicKeyString(next)) throw new ToolError('rotate needs the new public key (' + keyHint(next) + ')');
  if (from === next) throw new ToolError('rotate: the old and the new key are the same key');
  if (by === 'self') {
    if (!nextKey) return { t: 'rotate', from, next, by: 'self' };
    if (!nextKey.privateKey || nextKey.pub !== next) throw new ToolError('rotate --by self: --next-key is not the key named by --next');
    if (typeof ledgerId !== 'string' || !ledgerId) throw new ToolError('rotate --by self with --next-key needs the ledger id (read from the ledger file)');
    const nsig = b64url.encode(await sign(nextKey.privateKey, selfRotateSigningInput(ledgerId, from, next)));
    return { t: 'rotate', from, next, by: 'self', nsig };
  }
  if (by !== 'recover') throw new UsageError('rotate --by must be self or recover');
  if (!recover || !recover.privateKey || !isPublicKeyString(recover.pub)) throw new ToolError('rotate --by recover needs the recover key file (--recover-key)');
  if (typeof ledgerId !== 'string' || !ledgerId) throw new ToolError('rotate --by recover needs the ledger id (read from the ledger file)');
  const rsig = b64url.encode(await sign(recover.privateKey, rotateSigningInput(ledgerId, from, next)));
  return { t: 'rotate', from, next, by: 'recover', rp: recover.pub, rsig };
}

/** The effective ban, keyinfo and rotation state of the ledger, for show. */
function v03Summary(state) {
  return {
    keyinfo: state.keyinfo instanceof Map ? state.keyinfo.size : 0,
    keychange: state.keychange instanceof Map ? state.keychange.size : 0,
    checkpoint: state.checkpoint || null,
  };
}

/**
 * checkpointBlock({ blocks, identity, heads, now, ... }) → { block, blocks, S, snap, n, bytes, heads, file }
 * Computes the checkpoint state S over the causal past of `heads` (default: up to 8 current heads; the block can name at
 * most 8 parents, and every head must be one of them), appends the owner's { t:'checkpoint', heads, snap, n, bytes } block
 * and returns S as canonical JSON text in `file` (its SHA-256 is `snap`). Throws ToolError for a head that is not held, an
 * ownerConflict, or a state that does not verify against its own snap.
 */
export async function checkpointBlock({ blocks, identity, heads = null, now = Date.now(), genesisOwner = null, gen = null, expectedOwner = null } = {}) {
  const led = await loadLedger(blocks, { genesisOwner, gen, expectedOwner });
  if (led.invalid.length) throw new ToolError(led.invalid.length + ' invalid block(s) in the ledger file (first: ' + led.invalid[0].reason + '); fix the file first');
  if (!led.genesisOwner) throw new ToolError('the ledger has no genesis policy block; there is no owner to sign a checkpoint');
  let chosen = heads && heads.length ? sortedUnique(heads) : led.dag.heads({ limit: LIMITS.maxPrev }).slice().sort();
  if (chosen.length > LIMITS.maxPrev) throw new ToolError('a checkpoint block names at most ' + LIMITS.maxPrev + ' heads as parents; got ' + chosen.length);
  for (const h of chosen) if (!led.dag.has(h)) throw new ToolError('head ' + h + ' is not in the ledger file');
  let cp;
  try {
    cp = checkpointFor(led.dag, chosen, { genesisOwner: led.genesisOwner, expectedOwner });
  } catch (err) {
    throw new ToolError('cannot make a checkpoint: ' + (err && err.message ? err.message : String(err)));
  }
  const op = { t: 'checkpoint', heads: cp.heads, snap: cp.snap, n: cp.n, bytes: cp.bytes };
  const res = await appendControl({ blocks, identity, op, now, genesisOwner: led.genesisOwner, expectedOwner, prev: cp.heads });
  const file = canonicalize(cp.S);
  // The state must verify against the block it belongs to: a copy that holds S reduces from it.
  if (checkpointSnap(cp.S) !== cp.snap) throw new ToolError('internal: the checkpoint state does not hash to its snap');
  try {
    reduceFromCheckpoint(cp.S, [res.block], { genesisOwner: led.genesisOwner, expectedOwner, snap: cp.snap });
  } catch (err) {
    throw new ToolError('internal: the checkpoint state does not verify (' + (err && err.message ? err.message : String(err)) + ')');
  }
  return { block: res.block, blocks: res.blocks, S: cp.S, snap: cp.snap, n: cp.n, bytes: cp.bytes, heads: cp.heads, file };
}

// ---------------------------------------------------------------------------------------------
// cfg: the advisory _mw.cfg key (R 2.5.5, MF-22)
// ---------------------------------------------------------------------------------------------

/** The settings of _mw.cfg and the values each takes (src/chain/state.js cfgOk is the reader's schema). */
export const CFG_ENUMS = Object.freeze({
  chat: Object.freeze(['off', 'members', 'open']),
  files: Object.freeze(['off', 'members']),
  media: Object.freeze(['off', 'members']),
  // v0.3 C2 (SEEDING-AND-ZERO-SETUP-DESIGN 3.5): peer-to-peer calls between signed-in contacts; the default is off.
  calls: Object.freeze(['off', 'contacts']),
  records: Object.freeze(['off', 'sealed']),
  // 'introduced' (R 2.17.2): requests need an introduction. Introductions are not built, so the chat lane takes no message
  // requests with it (src/chat/service.js requestsOn; review round R 5.3, STALK-9).
  requests: Object.freeze(['off', 'on', 'introduced']),
  // Who may post on a person's wall (R 3.5; the social template reads it before its mw.prof fallback).
  wall: Object.freeze(['everyone', 'follow', 'nobody', 'approve']),
});
export const CFG_KEYS = Object.freeze(['chat', 'files', 'media', 'calls', 'records', 'maxItems', 'requests', 'chatBits', 'pin', 'turn', 'age', 'wall', 'blockTiers']);
/** The file kinds an owner may block with --block-tiers (src/chain/state.js CFG_TIERS, the kinds src/media/sniff.js reports). */
export { CFG_TIERS };
/** The most synced sealed items a record may hold (R 2.5.5, 2.6.2: one index item plus 31 data items). */
export const CFG_MAX_ITEMS = 32;
export const CFG_MAX_CHAT_BITS = 32;
export const CFG_TURN_URLS_MAX = 8;
export const DENY_REASONS = Object.freeze(['P0', 'illegal', 'malware', 'spam', 'other']);

const camelName = (name) => name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());

/**
 * cfgFromFlags(flags) → { set: { ... }, clear: [names] } from a parsed command line: only the settings that were given.
 * UsageError for a value the reader's schema would hide.
 */
export function cfgFromFlags(flags) {
  const set = {};
  for (const name of Object.keys(CFG_ENUMS)) {
    const v = flags[name];
    if (v === null || v === undefined) continue;
    if (CFG_ENUMS[name].indexOf(v) < 0) throw new UsageError('--' + name + ' must be ' + CFG_ENUMS[name].join(', ') + ' (got ' + JSON.stringify(v) + ')');
    set[name] = v;
  }
  if (flags.maxItems !== null && flags.maxItems !== undefined) {
    if (!Number.isSafeInteger(flags.maxItems) || flags.maxItems < 1 || flags.maxItems > CFG_MAX_ITEMS) {
      throw new UsageError('--max-items must be 1 to ' + CFG_MAX_ITEMS + ' (one index item plus up to 31 data items of 1,013 data bytes each)');
    }
    set.maxItems = flags.maxItems;
  }
  if (flags.chatBits !== null && flags.chatBits !== undefined) {
    if (!Number.isSafeInteger(flags.chatBits) || flags.chatBits < 0 || flags.chatBits > CFG_MAX_CHAT_BITS) throw new UsageError('--chat-bits must be 0 to ' + CFG_MAX_CHAT_BITS);
    set.chatBits = flags.chatBits;
  }
  const clear = [];
  if (flags.pin !== null && flags.pin !== undefined) {
    if (flags.pin === 'none') clear.push('pin');
    else if (!isPublicKeyString(flags.pin)) throw new UsageError('--pin must be the pin node\'s public key or none (' + keyHint(flags.pin) + ')');
    else set.pin = flags.pin;
  }
  if (flags.age !== null && flags.age !== undefined) {
    if (flags.age !== 'none' && !isPublicKeyString(flags.age)) throw new UsageError('--age must be none or the age verifier\'s public key (' + keyHint(flags.age) + ')');
    set.age = flags.age;
  }
  if (flags.blockTiers && flags.blockTiers.length) {
    const kinds = sortedUnique(flags.blockTiers.flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean));
    if (kinds.length === 1 && kinds[0] === 'none') clear.push('blockTiers');
    else {
      for (const k of kinds) if (CFG_TIERS.indexOf(k) < 0) throw new UsageError('--block-tiers takes kinds of ' + CFG_TIERS.join(', ') + ' (got ' + JSON.stringify(k) + ')');
      set.blockTiers = kinds;
    }
  }
  if (flags.turn && flags.turn.length) {
    const urls = flags.turn.flatMap((u) => String(u).split(',')).map((u) => u.trim()).filter(Boolean);
    if (urls.length === 1 && urls[0] === 'none') clear.push('turn');
    else {
      if (urls.length > CFG_TURN_URLS_MAX) throw new UsageError('--turn takes at most ' + CFG_TURN_URLS_MAX + ' URLs');
      for (const u of urls) if (u.length > 256 || !/^(turns?:|https:\/\/)[^\s]+$/.test(u)) throw new UsageError('--turn must be turn:, turns: or https: URLs, got ' + JSON.stringify(u));
      const mode = flags.turnMode || 'static';
      if (mode !== 'static' && mode !== 'endpoint') throw new UsageError('--turn-mode must be static or endpoint');
      set.turn = { urls: sortedUnique(urls), mode };
    }
  } else if (flags.turnMode) {
    throw new UsageError('--turn-mode needs --turn <url>');
  }
  for (const name of flags.clear || []) {
    const key = camelName(String(name));
    if (CFG_KEYS.indexOf(key) < 0) throw new UsageError('--clear takes one of ' + CFG_KEYS.join(', ') + ' (got ' + JSON.stringify(name) + ')');
    clear.push(key);
  }
  return { set, clear: sortedUnique(clear) };
}

/**
 * mergeCfg(current, { set, clear }) → the whole _mw.cfg object to write (keys sorted). Settings that are not passed keep
 * their value. Throws ToolError when the result would be hidden by the reader's schema or a setting depends on another
 * ("--max-items needs records sealed", "--chat-bits needs requests on").
 */
export function mergeCfg(current, { set = {}, clear = [] } = {}) {
  const next = Object.assign({}, current && typeof current === 'object' && !Array.isArray(current) ? current : {});
  for (const k of clear) delete next[k];
  Object.assign(next, set);
  if (set.maxItems !== undefined && next.records !== 'sealed') throw new ToolError('--max-items applies to synced records: set --records sealed with it (the setting is ' + (next.records || 'unset') + ')');
  const requestsOn = next.requests === 'on' || next.requests === 'introduced';
  if (set.chatBits !== undefined && !requestsOn) throw new ToolError('--chat-bits applies to message requests: set --requests on (or introduced) with it (the setting is ' + (next.requests || 'unset') + ')');
  // v0.3 C2: a call is signalled over the chat lane (SIG frames sealed with the pair key), so calls without chat would do nothing.
  if (next.calls === 'contacts' && (next.chat === undefined || next.chat === 'off')) {
    throw new ToolError(set.calls === 'contacts'
      ? '--calls contacts needs chat on: set --chat members (or open) with it (the setting is ' + (next.chat || 'unset') + ')'
      : 'calls are on (contacts) and need chat: turn them off with --calls off, or keep chat on (the chat setting would be ' + (next.chat || 'unset') + ')');
  }
  if (next.records !== 'sealed') delete next.maxItems;
  if (!requestsOn) delete next.chatBits;
  const keys = Object.keys(next).sort();
  const result = {};
  for (const k of keys) result[k] = next[k];
  if (!keys.length) throw new ToolError('nothing is set: pass at least one setting (or use --clear <name> to remove one)');
  if (!schemaOk('_mw.cfg', result, 'key')) {
    // The writer must never produce a setting the reader's schema hides. When the only reason is calls, say so: the reader's schema
    // (src/chain/state.js CFG) has to list it before a call setting can be written.
    const { calls, ...others } = result;
    const callsOnly = calls !== undefined && schemaOk('_mw.cfg', others, 'key');
    throw new ToolError('the settings do not match the _mw.cfg schema (readers would hide them): ' + JSON.stringify(result) +
      (callsOnly ? ' (the reader schema in src/chain/state.js does not list calls yet)' : ''));
  }
  return result;
}

/** The effective _mw.cfg of a loaded ledger ({} when unset or hidden). */
export function currentCfg(state) {
  const entry = state.kv && state.kv.get('_mw.cfg');
  return entry && entry.v && typeof entry.v === 'object' ? entry.v : {};
}

/** setCfg({ blocks, identity, set, clear, now }) → { block, blocks, cfg } */
export async function setCfg({ set = {}, clear = [], blocks, ...rest } = {}) {
  const led = await loadLedger(blocks, { genesisOwner: rest.genesisOwner || null, gen: rest.gen || null, expectedOwner: rest.expectedOwner || null });
  const cfg = mergeCfg(currentCfg(led.state), { set, clear });
  const res = await appendControl({ ...rest, blocks, op: { t: 'put', k: '_mw.cfg' }, value: cfg });
  return { block: res.block, blocks: res.blocks, cfg };
}

// ---------------------------------------------------------------------------------------------
// deny: a hash of the identifier, never the identifier (R 2.8.7)
// ---------------------------------------------------------------------------------------------

/**
 * denyKey(identifier) → '_deny/' + base64url(sha256(utf8(identifier))): the key under which a moderator records that an
 * infohash (40 lowercase hex) or a plaintext SHA-256 (64 lowercase hex) is not to be fetched or seeded. The ledger holds
 * a hash of the identifier, so it does not index the content.
 */
export async function denyKey(identifier) {
  const id = String(identifier === undefined || identifier === null ? '' : identifier).trim().toLowerCase();
  if (!HEX40.test(id) && !HEX64.test(id)) throw new ToolError('deny takes an infohash (40 hex characters) or a SHA-256 (64 hex characters), got ' + JSON.stringify(String(identifier)));
  return '_deny/' + b64url.encode(await sha256(utf8.encode(id)));
}

/** denyValue({ by, t, reason, ref }) → the _deny value { by, t, reason[, ref] } (the reader's schema is denyOk). */
export function denyValue({ by, t, reason, ref } = {}) {
  if (!isPublicKeyString(by)) throw new ToolError('deny: the signing key is not valid');
  if (DENY_REASONS.indexOf(reason) < 0) throw new UsageError('--reason must be one of ' + DENY_REASONS.join(', '));
  const v = { by, reason, t };
  if (ref !== undefined && ref !== null && ref !== '') v.ref = String(ref);
  return v;
}

/** denyIdentifier({ blocks, identity, id, reason, ref, now }) → { block, blocks, key, value } */
export async function denyIdentifier({ blocks, identity, id, reason, ref = null, now = Date.now(), ...rest } = {}) {
  const key = await denyKey(id);
  const value = denyValue({ by: identity.pub, t: now, reason, ref });
  if (!schemaOk(key, value, 'key')) throw new ToolError('the deny entry does not match its schema (the reference must be printable text of at most 256 characters)');
  const res = await appendControl({ ...rest, blocks, identity, now, op: { t: 'put', k: key }, value });
  return { block: res.block, blocks: res.blocks, key, value };
}

/**
 * The warning a policy that opens writing gets (MF-54; code review v0.3, round 2): genesis and policy print it when writers becomes
 * open, and publish notes it for an open genesis.
 */
export const OPEN_WRITING_WARNING = 'writers open: every visitor stores and passes on what strangers post on this site, and you moderate what ' +
  'your site makes visitors redistribute (docs/OPERATIONS.md, "The file lanes"). Prefer writers allow with join requests, and keep bits raised.';

// ---------------------------------------------------------------------------------------------
// listed: premoderation of a new key's first public files (R 2.17.1, MF-53; code review v0.3, round 2)
// ---------------------------------------------------------------------------------------------

/**
 * listedKey(ih, author?) → the key under which the owner or a moderator accepts a public listing (src/loader/mod.js
 * LISTED_PREFIX). With an author (review round R 5.3, MAL53-1): '_listed/' + base64url(sha256(utf8(ih + "\n" + author))),
 * bound to that author, so another key that lists the same infohash is never credited. Without one: the legacy key
 * '_listed/' + base64url(sha256(utf8(ih))), which mod.js credits only to a sole lister whose listing is older than it.
 * Honest copies then show that listing, and the author's later ones, in mw.files (mod.js listingVisible).
 */
export async function listedKey(ih, author = null) {
  const id = String(ih === undefined || ih === null ? '' : ih).trim().toLowerCase();
  if (!HEX40.test(id)) throw new ToolError('listed takes the infohash of the listing (40 hex characters), got ' + JSON.stringify(String(ih)));
  if (author === null || author === undefined) return '_listed/' + b64url.encode(await sha256(utf8.encode(id)));
  if (!isPublicKeyString(author)) throw new ToolError('listed --author takes the public key of the listing\'s author (' + keyHint(author) + ')');
  return '_listed/' + b64url.encode(await sha256(utf8.encode(id + '\n' + author)));
}

/** listingAuthors(blocks, ih) → the distinct authors of the mw.files listings of that infohash in the ledger file. */
export async function listingAuthors(blocks, ih) {
  const id = String(ih || '').trim().toLowerCase();
  const { state } = await loadLedger(blocks);
  const items = state && state.lists instanceof Map ? (state.lists.get('mw.files') || []) : [];
  return Array.from(new Set(items.filter((it) => it && it.v && it.v.ih === id && typeof it.author === 'string').map((it) => it.author)));
}

/**
 * acceptListing({ blocks, identity, ih, author?, now }) → { block, blocks, key, value }: the owner's or a moderator's offline
 * acceptance, bound to the listing's author (MAL53-1). Without --author the author is read from the ledger: the single key that
 * listed that infohash; none, or more than one, asks for --author. The value is { by, t, ih, author }.
 */
export async function acceptListing({ blocks, identity, ih, author = null, now = Date.now(), ...rest } = {}) {
  const id = String(ih === undefined || ih === null ? '' : ih).trim().toLowerCase();
  let who = author;
  if (who === null || who === undefined) {
    const found = await listingAuthors(blocks, id);
    if (found.length !== 1) {
      throw new ToolError(found.length ? found.length + ' keys listed ' + id + ': name the one you accept with --author <public key>' : 'no listing of ' + id + ' in this ledger file: give --author <public key>, or sync the file first');
    }
    who = found[0];
  }
  const key = await listedKey(id, who);
  const value = { by: identity.pub, t: now, ih: id, author: who };
  const res = await appendControl({ ...rest, blocks, identity, now, op: { t: 'put', k: key }, value });
  return { block: res.block, blocks: res.blocks, key, value };
}

// ---------------------------------------------------------------------------------------------
// capacity meter (R 2.6.2 owner budget, DS F10)
// ---------------------------------------------------------------------------------------------

const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
const fmtMiB = (n) => (n / 1048576).toFixed(n >= 10485760 ? 1 : 2) + ' MiB';

/**
 * capacityMeter({ members, items, maxChainBytes, usedBytes }) → { bytes, share, fits, lines, ... }
 * The owner budget of R 2.6.2: members x items x 1,877 bytes. 1,877 bytes is the accounted ledger cost of one sealed item at
 * one parent (the review's judge DS measured it); the products are arithmetic, not measurements. usedBytes (the bytes a
 * ledger file holds now) adds the real position.
 */
export function capacityMeter({ members = null, items = 4, maxChainBytes = DEFAULT_POLICY.maxChainBytes, usedBytes = null } = {}) {
  for (const [name, v] of [['members', members === null ? 0 : members], ['items', items], ['maxChainBytes', maxChainBytes]]) {
    if (!Number.isSafeInteger(v) || v < 0) throw new UsageError('capacity: ' + name + ' must be a non-negative integer');
  }
  // members: null reports only the position of a ledger file (--file without --members): there is no budget to compute
  const planned = members !== null;
  const bytes = planned ? members * items * SEALED_ITEM_BYTES : 0;
  const share = planned ? (maxChainBytes > 0 ? bytes / maxChainBytes : Infinity) : null;
  const lines = [];
  if (planned) {
    lines.push(
      'Capacity for synced sealed records (arithmetic from the accounted cost of one item; not a measurement of your site):',
      '  ' + fmtInt(members) + ' members x ' + fmtInt(items) + ' items x ' + fmtInt(SEALED_ITEM_BYTES) + ' bytes = ' + fmtInt(bytes) + ' bytes (' + fmtMiB(bytes) + ')',
      '  maxChainBytes ' + fmtInt(maxChainBytes) + ' bytes (' + fmtMiB(maxChainBytes) + '): this is ' + (share * 100).toFixed(1) + ' percent of it' + (bytes > maxChainBytes ? ' - more than fits: raise maxChainBytes (at most 64 MiB) or lower the items per member' : ''),
    );
    if (items > CFG_MAX_ITEMS) lines.push('  note: a record holds at most ' + CFG_MAX_ITEMS + ' synced items per author (--max-items)');
  } else {
    lines.push('Position of the ledger file (give --members <n> --items <n> for the budget of synced sealed records):');
    lines.push('  maxChainBytes ' + fmtInt(maxChainBytes) + ' bytes (' + fmtMiB(maxChainBytes) + ')');
  }
  if (usedBytes !== null) lines.push('  this ledger file now holds ' + fmtInt(usedBytes) + ' bytes (' + fmtMiB(usedBytes) + '), ' + (maxChainBytes > 0 ? (usedBytes / maxChainBytes * 100).toFixed(1) : 'n/a') + ' percent of maxChainBytes');
  return { members, items, perItemBytes: SEALED_ITEM_BYTES, bytes, maxChainBytes, share, fits: bytes <= maxChainBytes, usedBytes, lines };
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

const SPEC = {
  key: { type: 'string' },
  file: { type: 'string' },
  out: { type: 'string' },
  force: { type: 'boolean' },
  scope: { type: 'string' },
  chain: { type: 'string' },
  writers: { type: 'string' },
  policy: { type: 'string' },
  bits: { type: 'int' },
  'max-value-bytes': { type: 'int' },
  'max-chain-bytes': { type: 'int' },
  moderator: { type: 'list' },
  'clear-moderators': { type: 'boolean' },
  allow: { type: 'list' },
  'clear-allow': { type: 'boolean' },
  'mod-allow-per-day': { type: 'int' },
  'mod-actions-per-hour': { type: 'int' },
  'reserved-pool': { type: 'int' },
  void: { type: 'list' },
  'clear-voided': { type: 'boolean' },
  next: { type: 'string' },
  'next-key': { type: 'string' },
  add: { type: 'list' },
  remove: { type: 'list' },
  author: { type: 'string' },
  authors: { type: 'list' },
  before: { type: 'string' },
  until: { type: 'string' },
  h: { type: 'string' },
  by: { type: 'string' },
  from: { type: 'string' },
  'recover-key': { type: 'string' },
  'recover-pub': { type: 'string' },
  heads: { type: 'list' },
  'genesis-owner': { type: 'string' },
  'expected-owner': { type: 'string' },
  'accept-key': { type: 'string' },
  after: { type: 'string' },
  gen: { type: 'string' },
  chat: { type: 'string' },
  files: { type: 'string' },
  media: { type: 'string' },
  calls: { type: 'string' },
  records: { type: 'string' },
  requests: { type: 'string' },
  wall: { type: 'string' },
  'block-tiers': { type: 'list' },
  'max-items': { type: 'int' },
  'chat-bits': { type: 'int' },
  pin: { type: 'string' },
  age: { type: 'string' },
  turn: { type: 'list' },
  'turn-mode': { type: 'string' },
  clear: { type: 'list' },
  show: { type: 'boolean' },
  door: { type: 'list' },
  'clear-doors': { type: 'boolean' },
  ih: { type: 'string' },
  sha256: { type: 'string' },
  reason: { type: 'string' },
  ref: { type: 'string' },
  members: { type: 'int' },
  items: { type: 'int' },
};

const splitList = (list) => (list || []).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);

async function describe(blocks, opts) {
  const led = await loadLedger(blocks, opts);
  const snap = stateSnapshot(led.state, { now: Date.now() }); // banned: temporary bans count while in force
  out('ledger    ' + (led.site || '(empty)'));
  out('blocks    ' + led.dag.size + (led.invalid.length ? ' (' + led.invalid.length + ' invalid, skipped)' : '') + (led.orphans ? ' (' + led.orphans + ' without parents)' : ''));
  out('bytes     ' + led.dag.bytes);
  out('root      ' + led.dag.root());
  out('owner     ' + (snap.owner ? snap.owner + ' (' + (await fingerprint(snap.owner)) + ')' : 'none (unmoderated)') +
    (led.state.ownerConflict ? '  CONTESTED: two hand-overs by this key, ' + led.state.succession.conflict.join(' ') : ''));
  out('policy    writers=' + snap.policy.writers + ' bits=' + snap.policy.bits + ' maxValueBytes=' + snap.policy.maxValueBytes +
    ' maxChainBytes=' + snap.policy.maxChainBytes + ' moderators=' + snap.policy.moderators.length + ' allow=' + snap.policy.allowCount +
    ' banned=' + snap.policy.banned.length);
  out('freeze    modAllowPerDay=' + snap.policy.modAllowPerDay + ' modActionsPerHour=' + snap.policy.modActionsPerHour + ' reservedPool=' + snap.policy.reservedPool +
    ' voided=' + snap.policy.voided.length);
  const v3 = v03Summary(led.state);
  out('recovery  keyinfo=' + v3.keyinfo + ' key changes=' + v3.keychange + (v3.checkpoint ? ' checkpoint=' + v3.checkpoint.h.slice(0, 16) + '... covering ' + v3.checkpoint.n + ' blocks' : ' checkpoint=none'));
  const cfg = currentCfg(led.state);
  out('cfg       ' + (Object.keys(cfg).length ? JSON.stringify(cfg) : '(unset)'));
  out('heads     ' + led.dag.heads().join(' '));
  return led;
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '-h' || command === '--help') {
    out(USAGE.trim());
    return command ? 0 : 2;
  }
  const { flags, positionals } = parseCli(rest, SPEC);
  if (flags.help) {
    out(USAGE.trim());
    return 0;
  }
  if (positionals.length) throw new UsageError('unexpected argument ' + positionals[0]);
  const now = Date.now();
  const ledgerOpts = { genesisOwner: flags.genesisOwner || null, gen: flags.gen || null, expectedOwner: flags.expectedOwner || null };

  if (command === 'show') {
    if (!flags.file) throw new UsageError('show needs --file');
    await describe(readBlocksFile(flags.file), ledgerOpts);
    return 0;
  }
  if (command === 'capacity') {
    const maxChainBytes = flags.maxChainBytes !== null && flags.maxChainBytes !== undefined ? flags.maxChainBytes : null;
    let usedBytes = null;
    let ledgerMax = DEFAULT_POLICY.maxChainBytes;
    if (flags.file) {
      const led = await loadLedger(readBlocksFile(flags.file), ledgerOpts);
      usedBytes = led.dag.bytes;
      ledgerMax = led.state.policy.maxChainBytes;
    }
    if ((flags.members === null || flags.members === undefined) && usedBytes === null) throw new UsageError('capacity needs --members <n> (and --items <n>), or --file <ledger.json>');
    const meter = capacityMeter({
      members: flags.members === null || flags.members === undefined ? null : flags.members,
      items: flags.items === null || flags.items === undefined ? 4 : flags.items,
      maxChainBytes: maxChainBytes !== null ? maxChainBytes : ledgerMax,
      usedBytes,
    });
    for (const line of meter.lines) out(line);
    return meter.fits ? 0 : 1;
  }
  if (command === 'doors' && flags.show) {
    if (!flags.file) throw new UsageError('doors --show needs --file');
    const led = await loadLedger(readBlocksFile(flags.file), ledgerOpts);
    const e = led.state.kv.get(LEDGER_DOORS_KEY);
    out(JSON.stringify(e ? { value: e.v, author: e.author, h: e.h } : null, null, 2));
    return 0;
  }
  if (command === 'cfg' && flags.show) {
    if (!flags.file) throw new UsageError('cfg --show needs --file');
    const led = await loadLedger(readBlocksFile(flags.file), ledgerOpts);
    out(JSON.stringify(currentCfg(led.state), null, 2));
    return 0;
  }
  if (!flags.key) throw new UsageError(command + ' needs --key owner.jwk');
  const identity = await loadOwnerKey(flags.key);

  if (command === 'genesis') {
    if (!flags.out) throw new UsageError('genesis needs --out <file>');
    if (!flags.scope && !flags.chain) throw new UsageError('genesis needs --scope <hostname> (or --chain <label>)');
    if (existsSync(flags.out) && !flags.force) throw new ToolError(flags.out + ' exists; use --force to replace it');
    const ledgerId = await ledgerIdForOwner(identity.pub, { scope: flags.scope, chain: flags.chain });
    const policy = policyFromFlags(flags);
    if (policy.writers === 'open') warn(OPEN_WRITING_WARNING);
    const block = await createGenesis({ identity, ledgerId, policy, now });
    writeBlocksFile(flags.out, [block], { gzip: /\.gz$/i.test(flags.out) });
    out('ledger  ' + ledgerId);
    out('gen=' + block.h);
    out('wrote   ' + flags.out);
    return 0;
  }

  if (!flags.file) throw new UsageError(command + ' needs --file <ledger.json>');
  const blocks = readBlocksFile(flags.file);
  // Written back in the format it was read in: a gzip ledger file stays gzip (post-wave fix Q).
  const gzip = isGzipFile(flags.file);
  if (command === 'accept') {
    if (!/^[0-9a-f]{64}$/.test(String(flags.after || ''))) throw new UsageError('accept needs --after <64 hex hash of the hand-over to this key>');
    const res = await acceptHandover({ blocks, identity, after: flags.after, now, genesisOwner: ledgerOpts.genesisOwner, gen: ledgerOpts.gen });
    writeBlocksFile(flags.file, res.blocks, { gzip });
    out('appended the endorsement ' + res.block.h + ' of hand-over ' + flags.after + ' to ' + flags.file + (gzip ? ' (gzip, as it was)' : ''));
    await describe(res.blocks, { ...ledgerOpts, expectedOwner: identity.pub });
    return 0;
  }

  if (command === 'checkpoint') {
    const heads = splitList(flags.heads);
    for (const h of heads) if (!HEX64.test(h)) throw new UsageError('--heads takes 64 hex block hashes, got ' + JSON.stringify(h));
    const res = await checkpointBlock({ blocks, identity, heads: heads.length ? heads : null, now, ...ledgerOpts });
    const stateFile = flags.out || flags.file.replace(/(\.json)?(\.gz)?$/i, '') + '.checkpoint-state.json';
    writeFileAtomic(stateFile, res.file);
    writeBlocksFile(flags.file, res.blocks, { gzip });
    out('appended checkpoint block ' + res.block.h + ' to ' + flags.file + (gzip ? ' (gzip, as it was)' : ''));
    out('snap     ' + res.snap);
    out('covers   ' + res.n + ' blocks, heads ' + res.heads.map((h) => h.slice(0, 12)).join(' '));
    out('state    ' + stateFile + ' (' + res.bytes + ' bytes; the SHA-256 of this file is the snap)');
    out('A copy that holds this state file and checks its SHA-256 against the snap in the checkpoint block may drop the covered blocks and reduce from it.');
    // Review round (DS-2): every online copy prunes once the checkpoint reaches it, and mw_chain1 cannot carry the
    // state, so a copy that was offline (or a new visitor) catches up only from a cs= snapshot made after it.
    out('Next: node tools/snapshot.mjs ' + flags.file + ' --out snapshot.json.gz, upload it to the cs= URL of your pointer now.');
    out('Copies prune the covered blocks as soon as they see this checkpoint; a visitor who was away catches up only from that snapshot.');
    await describe(res.blocks, ledgerOpts);
    return 0;
  }

  let op;
  let value;
  let ensureInPast = [];
  let extraNotes = [];
  if (command === 'policy') {
    const partial = policyFromFlags(flags);
    if (!Object.keys(partial).length) throw new UsageError('policy needs at least one policy flag');
    if (partial.writers === 'open') warn(OPEN_WRITING_WARNING);
    op = policyOp(partial);
  } else if (command === 'owner') {
    if (!isPublicKeyString(flags.next)) throw new UsageError('owner needs --next <public key of the new owner> (' + keyHint(flags.next) + ')');
    op = { t: 'owner', next: flags.next };
  } else if (command === 'allow') {
    if (!flags.add.length && !flags.remove.length) throw new UsageError('allow needs --add and/or --remove');
    for (const p of flags.add.concat(flags.remove)) if (!isPublicKeyString(p)) throw new UsageError(keyHint(p) + ': ' + p);
    op = { t: 'allow' };
    if (flags.add.length) op.add = sortedUnique(flags.add);
    if (flags.remove.length) op.remove = sortedUnique(flags.remove);
  } else if (command === 'ban') {
    if (!isPublicKeyString(flags.author)) throw new UsageError('ban needs --author <public key> (' + keyHint(flags.author) + ')');
    op = banOp({ author: flags.author, until: flags.until === null || flags.until === undefined ? undefined : parseUntil(flags.until) });
    if (op.until !== undefined && op.until <= now) warn('--until is already in the past: the ban governs nothing');
  } else if (command === 'unban') {
    if (!isPublicKeyString(flags.author)) throw new UsageError('unban needs --author <public key> (' + keyHint(flags.author) + ')');
    op = unbanOp({ author: flags.author });
    extraNotes.push('Values the ban hid stay hidden; an unban does not bring them back.');
  } else if (command === 'tombstone') {
    const authors = splitList(flags.authors);
    if (authors.length || flags.before) {
      if (flags.h) throw new UsageError('tombstone takes --h <hash> or --authors ... --before <hash>, not both');
      for (const p of authors) if (!isPublicKeyString(p)) throw new UsageError(keyHint(p) + ': ' + p);
      op = bulkTombstoneOp({ authors, before: flags.before });
      ensureInPast = [flags.before];
    } else {
      if (!/^[0-9a-f]{64}$/.test(String(flags.h || ''))) throw new UsageError('tombstone needs --h <64 hex block hash> (or --authors ... --before <hash>)');
      op = { t: 'tombstone', h: flags.h };
    }
  } else if (command === 'keyinfo') {
    let recoverPub = flags.recoverPub;
    if (flags.recoverKey) {
      const recover = await loadOwnerKey(flags.recoverKey);
      if (recoverPub && recoverPub !== recover.pub) throw new UsageError('--recover-pub is not the public half of --recover-key');
      recoverPub = recover.pub;
    }
    if (!recoverPub) throw new UsageError('keyinfo needs --recover-key <recover key file> (or --recover-pub <public key>)');
    if (recoverPub === identity.pub) throw new ToolError('the recover key must not be the key it protects: make a separate one (node tools/keygen.mjs) and keep it offline');
    op = await keyinfoOp({ recoverPub });
    extraNotes.push('rc = ' + op.rc + ' (base64url sha256 of the recover public key). Keep the recover key file offline: whoever holds it can replace this key.');
  } else if (command === 'rotate') {
    if (flags.by !== 'self' && flags.by !== 'recover') throw new UsageError('rotate needs --by self or --by recover');
    if (flags.by === 'self') {
      let next = flags.next;
      let nextKey = null;
      if (flags.nextKey) {
        nextKey = await loadOwnerKey(flags.nextKey);
        if (next && next !== nextKey.pub) throw new UsageError('--next is not the public half of --next-key');
        next = nextKey.pub;
      }
      if (!isPublicKeyString(next)) throw new UsageError('rotate --by self needs --next <public key> or --next-key <file> (' + keyHint(next) + ')');
      const led = nextKey ? await loadLedger(blocks, ledgerOpts) : null;
      op = await rotateOp({ by: 'self', from: identity.pub, next, ledgerId: led ? led.site : undefined, nextKey });
      if (!nextKey) extraNotes.push('No --next-key: the new key did not sign (nsig), so this only retires the old key; bans and allow-list membership do not move. Give --next-key to move them.');
    } else {
      if (!isPublicKeyString(flags.from)) throw new UsageError('rotate --by recover needs --from <public key of the key being replaced> (' + keyHint(flags.from) + ')');
      if (!flags.recoverKey) throw new UsageError('rotate --by recover needs --recover-key <recover key file>');
      const recover = await loadOwnerKey(flags.recoverKey);
      const led = await loadLedger(blocks, ledgerOpts);
      op = await rotateOp({ by: 'recover', from: flags.from, next: identity.pub, ledgerId: led.site, recover });
    }
    if (op.by === 'recover' || op.nsig) extraNotes.push('Readers will show "key changed" for ' + op.from.slice(0, 14) + '...; bans and allow-list membership move to the new key, moderator and owner standing do not.');
  } else if (command === 'cfg') {
    const { set, clear } = cfgFromFlags(flags);
    if (!Object.keys(set).length && !clear.length) throw new UsageError('cfg needs at least one setting (or --show)');
    const led = await loadLedger(blocks, ledgerOpts);
    const merged = mergeCfg(currentCfg(led.state), { set, clear });
    op = { t: 'put', k: '_mw.cfg' };
    value = merged;
    extraNotes.push('_mw.cfg is advisory: honest loaders enforce it and the page shows who set it; nothing security-relevant is stored there.');
    extraNotes.push(JSON.stringify(merged));
  } else if (command === 'doors') {
    // v0.3 C2 doors (S4 D5): { v: 1, d: [host, ...] }, at most 24 hosts and 2,048 bytes; readers take one change an hour.
    op = { t: 'put', k: LEDGER_DOORS_KEY };
    if (flags.clearDoors) value = null;
    else {
      try { value = ledgerDoorsValue(flags.door); } catch (err) { throw new UsageError('doors needs --door <host>... (lowercase host or host:port, at most 24): ' + err.message); }
    }
    extraNotes.push('Readers use the owner\'s _doors only (a moderator\'s is hidden), and on each device at most one change an hour; the item tells an open page or a stored copy where else the site lives, it cannot move a link.');
  } else if (command === 'deny') {
    const id = flags.ih || flags.sha256;
    if (!id || (flags.ih && flags.sha256)) throw new UsageError('deny needs --ih <40 hex infohash> or --sha256 <64 hex>, one of them');
    if (!flags.reason) throw new UsageError('deny needs --reason ' + DENY_REASONS.join('|'));
    if (flags.ih && !HEX40.test(String(flags.ih).toLowerCase())) throw new UsageError('--ih takes 40 hex characters');
    if (flags.sha256 && !HEX64.test(String(flags.sha256).toLowerCase())) throw new UsageError('--sha256 takes 64 hex characters');
    const key = await denyKey(id);
    value = denyValue({ by: identity.pub, t: now, reason: flags.reason, ref: flags.ref });
    op = { t: 'put', k: key };
    extraNotes.push('key ' + key + ' (a hash of the identifier; the ledger does not list the identifier itself)');
    extraNotes.push('Also tombstone the listing (tombstone --h <block hash>) in the same moderation step: a tombstone without a denylist entry lets the same file come back.');
  } else if (command === 'listed') {
    if (!HEX40.test(String(flags.ih || '').toLowerCase())) throw new UsageError('listed needs --ih <40 hex infohash of the listing>');
    if (flags.author !== null && flags.author !== undefined && !isPublicKeyString(flags.author)) throw new UsageError('listed --author takes a public key (' + keyHint(flags.author) + ')');
    const ihId = String(flags.ih).toLowerCase();
    let who = flags.author || null;
    if (!who) {
      const found = await listingAuthors(blocks, ihId);
      if (found.length !== 1) throw new UsageError(found.length ? found.length + ' keys listed ' + ihId + ': name the one you accept with --author <public key>' : 'no listing of ' + ihId + ' in ' + flags.file + ': give --author <public key>');
      who = found[0];
    }
    const key = await listedKey(ihId, who);
    op = { t: 'put', k: key };
    value = { by: identity.pub, t: now, ih: ihId, author: who };
    extraNotes.push('key ' + key + ': honest copies now show this author\'s listing and that author\'s later ones (premoderation); another key that lists the same file is not accepted by it. A decline is a tombstone of the listing (tombstone --h).');
  } else {
    throw new UsageError('unknown command ' + command);
  }
  let res = await appendControl({ blocks, identity, op, value, now, ensureInPast, ...ledgerOpts });
  out('appended ' + op.t + ' block ' + res.block.h + ' to ' + flags.file);
  for (const line of extraNotes) out(line);
  if (op.t === 'owner' && flags.acceptKey) {
    const next = await loadOwnerKey(flags.acceptKey);
    if (next.pub !== op.next) throw new ToolError('--accept-key holds ' + (await fingerprint(next.pub)) + ', not the --next key');
    const handover = res.block.h;
    res = await acceptHandover({ blocks: res.blocks, identity: next, after: handover, now, genesisOwner: ledgerOpts.genesisOwner, gen: ledgerOpts.gen });
    out('appended the new owner\'s endorsement ' + res.block.h + ' of hand-over ' + handover);
  }
  writeBlocksFile(flags.file, res.blocks, { gzip });
  if (gzip) out('wrote ' + flags.file + ' as gzip, as it was');
  await describe(res.blocks, op.t === 'owner' ? { ...ledgerOpts, expectedOwner: op.next } : ledgerOpts);
  out('');
  out('Next: node tools/snapshot.mjs ' + flags.file + ' --out snapshot.json.gz, upload it to the cs= URL of your pointer.');
  if (op.t === 'owner') {
    warn('the next pointer must carry the new owner key (a nx= commitment to it, or a rot= signature by this key); seq must increase');
    if (!flags.acceptKey) warn('the new owner should endorse this hand-over: node tools/ledger-admin.mjs accept --key <new key> --file ' + flags.file + ' --after ' + res.block.h);
  }
  return 0;
}

if (isMain(import.meta.url)) runMain(main, USAGE);
