// tools/withdraw.mjs: `node tools/publish.mjs --withdraw` (v0.2.1, DIGEST-AMENDMENTS A3;
// PRODUCTION-DIGEST D13, P0-16 and 9.2 (d)). Writes a signed withdrawal record for a scope:
//
//   v=mw1; st=withdrawn; btih=0000000000000000000000000000000000000000; owner=p256:...; [chain=...;]
//   [ct=...;] [why=...;] seq=<n+1>; exp=<unix>; sig=...
//
// A loader that sees it (signed by the pinned owner, or with a valid rot=, and with a higher seq
// than the record it holds) stops serving and seeding the scope and deletes every stored version
// of it; loaders that predate st= find nothing to fetch under the zero infohash. The record names
// no content, so it carries no xs=, ws=, tr= or gen=. Publish it everywhere the pointer lives: the
// <meta name="mw-pointer"> of the shell (index.html, 404.html) or of every stamped drop-in page,
// and the _magnet TXT record. Devices that stay offline keep their copy until they come back.
//
//   node tools/publish.mjs --withdraw --scope <hostname> --key owner.jwk [--why <reason>] [--ct <url>]
//     [--chain <label>] [--seq <n>] [--exp <days>] [--prev-key <old owner.jwk>] [--prev-pointer <file>] [--out dist-publish] [--quiet]
//
// v0.3 nx= (MF-28; review round PTR-7): the withdrawal carries the nx= of the record it replaces (read from --prev-pointer, or from
// <out>/pointer.txt before it is overwritten), and it is checked as a returning visitor checks it, against that record: a device that
// holds a record committing to a next key refuses a record of the same owner without the same nx= ('nx-changed'), and a record of
// another owner unless that owner is the committed key ('nx-mismatch'). A withdrawal that would be refused is not written.
//
// Outputs in --out: pointer.txt, meta.html, dns.txt, summary.json (mode "withdraw"); a stale
// magnet.txt from an earlier publish is removed (a withdrawal has no magnet).

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  withdrawalRecord, signPointer, signRotation, verifyPointer, formatPointer, normalizeScope, ledgerIdFor,
  pointerBudget, splitTxt, MAX_PUBLISH_EXP_DAYS, SEQ_PUBLISH_SLACK_S, WHY_CODES, POINTER_SIZE_SHOULD, POINTER_SIZE_MAX,
} from '../src/common/pointer.js';
import { isPublicKeyString } from '../src/chain/crypto.js';
import { loadOwnerKey, writeFileAtomic, removeTree, isoDate, relPath, ToolError, UsageError, out, warn, TOOLS_VERSION } from './lib.mjs';

/** Flags `publish --withdraw` adds to the publish command line (tools/publish.mjs merges them). */
export const WITHDRAW_FLAGS = {
  withdraw: { type: 'boolean' },
  why: { type: 'string' },
  ct: { type: 'string' },
};

/**
 * A withdrawal stays valid as long as the tools sign (an expired one is ignored by fresh lookups):
 * 399 days, one under the 400-day limit (code review round 1: at exactly 400 days, a visitor whose
 * clock lagged the signer's by a second refused it as exp-too-far, and the withdrawn site kept rendering).
 */
export const WITHDRAW_EXP_DAYS = MAX_PUBLISH_EXP_DAYS;
const WHY_MAX_BYTES = 120;

function checkWhy(why) {
  if (why === null || why === undefined || why === '') return null;
  if (typeof why !== 'string') throw new UsageError('--why must be text');
  const text = why.trim();
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new UsageError('--why must not contain control characters');
  if (Buffer.byteLength(text, 'utf8') > WHY_MAX_BYTES) throw new UsageError('--why is shown to every visitor and kept short: at most ' + WHY_MAX_BYTES + ' bytes (or one of ' + WHY_CODES.join(', ') + ')');
  return text || null;
}

function checkContact(ct) {
  if (ct === null || ct === undefined || ct === '') return null;
  let u;
  try {
    u = new URL(ct);
  } catch (_) {
    throw new UsageError('--ct must be an https: or mailto: URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'mailto:') throw new UsageError('--ct must be an https: or mailto: URL');
  return ct;
}

/**
 * withdraw({ scope, key, why, ct, chain, seq, exp, prevKey, prevPointer, out, now, quiet }) → result
 * result = { mode: 'withdraw', scope, owner, fingerprint, ledgerId, seq, exp, pointer, record, budget,
 *            outDir, outputs, warnings, summary }
 * seq defaults to the Unix time (it must be higher than the seq of the record it replaces, and never
 * later than the clock); exp is in days (default 399, the most the tools sign, because an expired
 * withdrawal is ignored by fresh lookups). ledgerOwner: the lo= of a site whose key was rotated.
 */
export async function withdraw(options) {
  const given = {};
  for (const [k, v] of Object.entries(options || {})) if (v !== undefined && v !== null) given[k] = v;
  const o = Object.assign({ out: 'dist-publish', now: Date.now(), quiet: false, exp: WITHDRAW_EXP_DAYS }, given);
  const log = o.quiet ? () => {} : out;
  const warnings = [];
  const note = (msg) => {
    warnings.push(msg);
    if (!o.quiet) warn(msg);
  };
  if (!o.scope) throw new UsageError('--withdraw needs --scope <hostname>');
  if (/^btih:/i.test(o.scope)) throw new UsageError('--withdraw signs per-domain pointers; --scope must be a hostname');
  let scope;
  try {
    scope = normalizeScope(o.scope);
  } catch (_) {
    throw new UsageError('invalid --scope: ' + o.scope);
  }
  if (!o.key) throw new UsageError('--withdraw needs --key owner.jwk (the key that signed the pointer, or the new key with --prev-key)');
  if (!Number.isInteger(o.exp) || o.exp < 1 || o.exp > MAX_PUBLISH_EXP_DAYS) throw new UsageError('--exp must be 1 to ' + MAX_PUBLISH_EXP_DAYS + ' days');
  if (o.ledgerOwner && !isPublicKeyString(o.ledgerOwner)) throw new UsageError('--ledger-owner must be a tagged public key (p256:...)');
  if (o.chain && !/^[\x21-\x7e]{1,64}$/.test(o.chain)) throw new UsageError('--chain must be 1 to 64 printable ASCII characters');
  const why = checkWhy(o.why);
  const ct = checkContact(o.ct);
  if (why && WHY_CODES.indexOf(why) < 0) note('--why "' + why + '" is shown to visitors as written; the reason codes are ' + WHY_CODES.join(', '));

  const identity = await loadOwnerKey(o.key);
  const nowSec = Math.floor(o.now / 1000);
  const seq = o.seq !== null && o.seq !== undefined ? o.seq : nowSec;
  if (!Number.isSafeInteger(seq) || seq < 0 || seq > nowSec + SEQ_PUBLISH_SLACK_S) throw new UsageError('--seq must be a non-negative integer no later than the current Unix time (' + nowSec + ')');
  const exp = nowSec + o.exp * 86400;
  let rot = null;
  if (o.prevKey) {
    const previous = await loadOwnerKey(o.prevKey);
    if (previous.pub === identity.pub) throw new UsageError('--prev-key is the same key as --key');
    rot = await signRotation({ owner: identity.pub, seq, scope, chain: o.chain || null }, previous.privateKey);
  }
  const lo = o.ledgerOwner && o.ledgerOwner !== identity.pub ? o.ledgerOwner : null;
  // dnsTxt, metaTag and readPreviousPointer live in publish.mjs, which imports this module: load it when needed.
  const { dnsTxt, metaTag, readPreviousPointer } = await import('./publish.mjs');
  const outDir = resolve(o.out);
  // The record this one replaces, read before <out>/pointer.txt is overwritten (PTR-7).
  const previous = readPreviousPointer({ prevPointer: o.prevPointer || null, outDir, scope });
  const nx = previous && previous.nx && previous.owner === identity.pub ? previous.nx : null;
  const record = await signPointer(withdrawalRecord({ owner: identity.pub, seq, exp, why, ct, chain: o.chain || null, rot, lo, nx }), scope, identity.privateKey);
  const pointer = formatPointer(record);
  const check = await verifyPointer(record, scope, { now: o.now });
  if (!check.ok || !check.withdrawn) throw new Error('internal: the withdrawal does not verify as a withdrawal (' + (check.reason || check.status) + ')');
  if (previous) {
    // As a returning visitor's loader checks it: against the record it holds (src/loader/app.js resolvePointer, previousRecord).
    const returning = await verifyPointer(record, scope, { now: o.now, previousRecord: previous, pinnedOwner: previous.owner, cachedSeq: previous.seq });
    if (!returning.ok) {
      const why = returning.reason === 'nx-mismatch'
        ? 'the previous pointer commits to a next owner key (nx=' + previous.nx + ') and ' + identity.fingerprint + ' is not that key. Sign the withdrawal with the committed next key ' +
          '(--key <next key> --prev-key <current key>), or devices that hold the previous record ignore it'
        : 'devices that hold the previous record (seq ' + previous.seq + ') would refuse it (' + returning.reason + ')';
      throw new ToolError('refusing to write the withdrawal: ' + why + '. Nothing was written.');
    }
  }
  const budget = pointerBudget(pointer);
  if (!budget.withinMax) throw new ToolError('the withdrawal is ' + budget.bytes + ' bytes; a pointer must stay at or under ' + POINTER_SIZE_MAX + ' bytes (shorten --why or --ct)');
  if (!budget.withinShould) note('the withdrawal is ' + budget.bytes + ' bytes; pointers should stay at or under ' + POINTER_SIZE_SHOULD + ' bytes (shorten --why or --ct)');
  const ledgerId = await ledgerIdFor(record, o.chain ? 'btih:' + '0'.repeat(40) : scope);

  mkdirSync(outDir, { recursive: true });
  const outputs = [];
  const write = (rel, data) => {
    writeFileAtomic(join(outDir, rel), data);
    outputs.push(rel);
  };
  removeTree(join(outDir, 'magnet.txt'));
  write('pointer.txt', pointer + '\n');
  write('meta.html', metaTag(pointer) + '\n');
  write('dns.txt', dnsTxt({ scope, pointer }));
  const summary = {
    v: 1,
    tool: 'felinar publish ' + TOOLS_VERSION,
    mode: 'withdraw',
    withdrawn: true,
    scope,
    ledgerId,
    owner: identity.pub,
    fingerprint: identity.fingerprint,
    chain: o.chain || null,
    seq,
    exp,
    expires: isoDate(exp * 1000),
    why,
    ct,
    rotated: Boolean(rot),
    nx: nx || null,
    pointer,
    bytes: budget.bytes,
    dns: { name: '_magnet.' + scope, chunks: splitTxt(pointer).length },
  };
  write('summary.json', JSON.stringify(summary, null, 2) + '\n');

  log('felinar publish --withdraw');
  log('  scope     ' + scope);
  log('  owner     ' + identity.fingerprint + (rot ? ' (rotated from --prev-key)' : '') + (nx ? ' (keeps nx= of the previous record: devices that hold it accept this)' : ''));
  log('  record    seq ' + seq + ', expires ' + summary.expires + ' (' + o.exp + ' days), ' + budget.bytes + ' bytes, ' + summary.dns.chunks + ' TXT string(s)');
  log('  outputs   ' + relPath(outDir) + '/: ' + outputs.join(', '));
  log('');
  log('Withdrawal (replace the pointer everywhere it is published: the <meta name="mw-pointer"> of the shell');
  log('index.html and 404.html, or of every stamped drop-in page, and the _magnet TXT record from dns.txt):');
  log(pointer);
  log('');
  log('Loaders that see it stop sharing the site and delete every copy they hold. Devices that stay offline keep');
  log('theirs until they come back. Keep the withdrawal published; publish again (higher seq) before ' + summary.expires + '.');
  return {
    mode: 'withdraw', scope, owner: identity.pub, fingerprint: identity.fingerprint, ledgerId, seq, exp, pointer, record, budget,
    outDir, outputs, warnings, summary,
  };
}
