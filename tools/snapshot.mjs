#!/usr/bin/env node
// tools/snapshot.mjs: writes a ledger snapshot for the pointer's cs= (ARCHITECTURE sections 5.5,
// 6.7, 10; DESIGN-REVIEW S2). The loader downloads cs= after it has rendered and offers every block
// in it to its node, so a first visitor gets the ledger even when nobody else is online.
//
//   node tools/snapshot.mjs <export.json|url> --out <file> [--recent-out <file>] [--posts <n>] [--plain]
//                           [--genesis-owner <pub>] [--gen <h>] [--max-bytes <n>] [--remote] [--wait <seconds>]
//                           [--profile <dir>] [--quiet]
//
// v0.3 (V03-DESIGN-REVIEW 3.2.2 "Snapshot first", E-SO-6): --recent-out also writes the ledger's recent
// window, the newest --posts (200) payload blocks with every block above them, every control block and,
// when a checkpoint is in effect, its state S in place of the blocks it covers (src/chain/recent.js). The
// file is a JSON array [header, ...blocks] that the loader's snapshot reader accepts; the hub follow lane's
// first screen loads it with loadRecentSnapshot(). Either file can be written alone (--out or --recent-out).
//
// <export.json>  a ledger export: a JSON array of blocks (Settings, Export ledger JSON; genesis.json
//                or a ledger file of tools/ledger-admin.mjs), an object with a "blocks" array, or a
//                gzip of either
// <url>          a URL that serves such a file (loopback addresses directly; anything else needs
//                --remote, because this tool then reaches the internet), or the URL of a live site:
//                Playwright Chromium opens it like a visitor, waits for the ledger to sync and reads
//                the site's IndexedDB. Use tools/pin.mjs for a node that stays up.
//
// Every block is validated (hash, signature, proof of work, value hash); invalid blocks and blocks
// whose parents are missing are dropped and counted. Values that the ledger has redacted (a tombstone,
// a ban) are removed from the snapshot, so it never republishes what the owner took down. The output
// is gzip-compressed JSON by default; --plain writes uncompressed JSON (hosts usually compress JSON in
// transit anyway). Since code review round 1 every loader reads the gzip file, browsers without
// DecompressionStream (Safari and iOS 15.4 to 16.3) through src/common/inflate.js.

import { gzipSync, gunzipSync } from 'node:zlib';

import { redact, blockBytes } from '../src/chain/block.js';
import { dbNameFor } from '../src/chain/stores.js';
import { snapshot as stateSnapshot, checkpointFor } from '../src/chain/state.js';
import { Dag } from '../src/chain/dag.js';
import { windowFromDag, encodeRecentSnapshot, RECENT_POSTS } from '../src/chain/recent.js';
import { parsePointer, ledgerIdFor, normalizeScope } from '../src/common/pointer.js';
import { CONFIG } from '../src/loader/config.js';
import { loadLedger, readBlocksFile, formatBlocks } from './ledger-admin.mjs';
import {
  parseCli, runMain, isMain, readMeta, writeFileAtomic, isLoopbackUrl, formatBytes, ToolError, UsageError, out, warn,
} from './lib.mjs';

const USAGE = `
Usage: node tools/snapshot.mjs <export.json|url> --out <file> [--recent-out <file>] [--posts <n>] [--plain]
                               [--genesis-owner <pub>] [--gen <hash>] [--max-bytes <n>] [--remote]
                               [--wait <seconds>] [--profile <dir>] [--quiet]
  --recent-out <file>  also (or only) write the recent window for the hub follow lane's first screen
  --posts <n>          payload blocks in the recent window (1 to 200, default 200)
`;

/** Parses the bytes of a ledger export (JSON array, { blocks }, a single block, optionally gzip) → Block[]. */
export function parseExport(bytes, label = 'input') {
  let data = Buffer.from(bytes);
  if (data[0] === 0x1f && data[1] === 0x8b) data = gunzipSync(data);
  let value;
  try {
    value = JSON.parse(data.toString('utf8'));
  } catch (err) {
    throw new ToolError(label + ' is not JSON: ' + err.message);
  }
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && Array.isArray(value.blocks)) return value.blocks;
  if (value && typeof value === 'object' && value.e && value.h) return [value];
  throw new ToolError(label + ' is not a ledger export (expected a JSON array of blocks)');
}

/**
 * buildSnapshot({ blocks, genesisOwner, gen, maxBytes, checkpoint }) → { blocks: Block[] (by depth then hash), entries,
 *   site, owner, height, bytes, root, invalid, orphans, redacted, tombstoned, state, checkpoint }
 * Validates every block, keeps the connected ones, removes redacted values. Throws ToolError when
 * nothing is valid or the result is larger than maxBytes. A pruned ledger (its export starts with
 * { mw: 'checkpoint-v1', checkpoint }, or `checkpoint` { h, snap, S } is given, code review v0.3)
 * gives entries = [that header, ...blocks], what encodeSnapshot writes: a visitor's node applies S
 * first, then the blocks after it connect. Otherwise entries are the blocks.
 */
export async function buildSnapshot({ blocks, genesisOwner = null, gen = null, maxBytes = CONFIG.ledger.snapshotMaxBytes, checkpoint = null }) {
  if (!Array.isArray(blocks)) throw new ToolError('no blocks to write');
  const led = await loadLedger(blocks, { genesisOwner, gen, checkpoint });
  if (!led.dag.size) {
    throw new ToolError('the export holds no valid block' + (led.invalid.length ? ' (' + led.invalid.length + ' were invalid, first: ' + led.invalid[0].reason + ')' : ''));
  }
  const ordered = led.dag.order();
  let redacted = 0;
  const kept = ordered.map((b) => {
    if (b.v !== undefined && led.state.redacted && led.state.redacted.has(b.h)) {
      redacted++;
      return redact(b);
    }
    return b;
  });
  const header = led.checkpoint ? { mw: 'checkpoint-v1', ledger: led.site, checkpoint: { h: led.checkpoint.h, snap: led.checkpoint.snap, S: led.checkpoint.S } } : null;
  const bytes = kept.reduce((n, b) => n + blockBytes(b), 0) + (header ? Buffer.byteLength(JSON.stringify(header)) : 0);
  if (bytes > maxBytes) throw new ToolError('the snapshot would hold ' + formatBytes(bytes) + ' of blocks, more than ' + formatBytes(maxBytes) + ' (visitors refuse a larger cs= file)');
  return {
    blocks: kept,
    entries: header ? [header].concat(kept) : kept,
    checkpoint: led.checkpoint ? { h: led.checkpoint.h, snap: led.checkpoint.snap } : null,
    site: led.site,
    owner: led.state.owner,
    height: kept.length,
    bytes,
    root: led.dag.root(),
    invalid: led.invalid,
    orphans: led.orphans,
    redacted,
    tombstoned: led.state.tombstoned.size,
    state: led.state,
  };
}

/**
 * buildRecentSnapshot({ blocks, posts, genesisOwner, gen, maxBytes }) → { entries: [header, ...blocks], window,
 *   site, owner, height, bytes, checkpoint, invalid, orphans }: the recent window of a ledger export (v0.3, see
 * the header). Blocks are validated as for buildSnapshot; values the ledger has redacted travel as stubs; with
 * a checkpoint in effect, S stands for the blocks it covers. Throws ToolError when nothing is valid or the
 * window is larger than maxBytes.
 */
export async function buildRecentSnapshot({ blocks, posts = RECENT_POSTS, genesisOwner = null, gen = null, maxBytes = CONFIG.ledger.snapshotMaxBytes }) {
  if (!Array.isArray(blocks)) throw new ToolError('no blocks to write');
  const led = await loadLedger(blocks, { genesisOwner, gen });
  if (!led.dag.size) {
    throw new ToolError('the export holds no valid block' + (led.invalid.length ? ' (' + led.invalid.length + ' were invalid, first: ' + led.invalid[0].reason + ')' : ''));
  }
  const n = Number.isSafeInteger(posts) ? posts : RECENT_POSTS;
  if (n < 1 || n > RECENT_POSTS) throw new ToolError('--posts must be 1 to ' + RECENT_POSTS);
  let dag = led.dag;
  let checkpoint = null;
  const cp = led.state.checkpoint;
  if (led.checkpoint) {
    // A pruned export (code review v0.3): its S is the checkpoint state the window carries.
    checkpoint = { h: led.checkpoint.h, snap: led.checkpoint.snap, S: led.checkpoint.S };
  } else if (cp && cp.h && led.genesisOwner) {
    // The checkpoint in effect: S over its heads (what the owner signed), computed on the blocks of their
    // causal past (on the whole DAG the checkpoint already covers them), the covered blocks left out.
    const block = led.dag.get(cp.h);
    try {
      const past = new Set(block.e.op.heads);
      for (const h of block.e.op.heads) for (const a of led.dag.ancestors(h)) past.add(a);
      const sub = new Dag({ maxOrphans: Infinity, maxOrphansPerPeer: Infinity });
      for (const b of led.dag.order()) if (past.has(b.h)) sub.add(b, 'file');
      const made = checkpointFor(sub, block.e.op.heads, { genesisOwner: led.genesisOwner });
      if (made.snap === cp.snap) {
        const pruned = new Dag({ maxOrphans: Infinity, maxOrphansPerPeer: Infinity });
        pruned.pruneTo(block, made.S);
        for (const b of led.dag.order()) if (!pruned.has(b.h) && !pruned.isCovered(b.h)) pruned.add(b, 'file');
        dag = pruned;
        checkpoint = { h: cp.h, snap: cp.snap, S: made.S };
      }
    } catch (_) {
      checkpoint = null; // a window without S still holds every control block
    }
  }
  const redacted = led.state.redacted;
  const window = windowFromDag(dag, {
    posts: n,
    hidden: redacted && redacted.size > 0 ? (h) => redacted.has(h) : null,
    checkpoint,
  });
  const entries = encodeRecentSnapshot(window, led.site);
  const bytes = window.blocks.reduce((sum, b) => sum + blockBytes(b), 0);
  if (bytes > maxBytes) throw new ToolError('the recent window would hold ' + formatBytes(bytes) + ' of blocks, more than ' + formatBytes(maxBytes));
  return {
    entries,
    window,
    site: led.site,
    owner: led.state.owner,
    height: window.blocks.length,
    bytes,
    checkpoint: checkpoint ? { h: checkpoint.h, snap: checkpoint.snap } : null,
    invalid: led.invalid,
    orphans: led.orphans,
  };
}

/** encodeSnapshot(blocks, { plain }) → Buffer: gzip of the JSON array (one block per line), or the plain JSON. */
export function encodeSnapshot(blocks, { plain = false } = {}) {
  const text = formatBlocks(blocks);
  return plain ? Buffer.from(text, 'utf8') : gzipSync(Buffer.from(text, 'utf8'), { level: 9 });
}

// ---------------------------------------------------------------------------------------------
// input from a URL
// ---------------------------------------------------------------------------------------------

async function exportFromLiveSite(url, html, { waitSeconds, profileDir, log }) {
  const pointerText = readMeta(html, 'mw-pointer');
  let dbName = null;
  if (pointerText) {
    const parsed = parsePointer(pointerText);
    if (parsed.ok) dbName = dbNameFor(await ledgerIdFor(parsed.record, normalizeScope(new URL(url).hostname)));
  }
  const live = await import('./live.mjs');
  log('opening ' + url + ' in Chromium (it reaches the trackers and peers named in the pointer)');
  // Code review round 1 (docs/DEV-NETWORK.md): a loopback page gets the local-only browser (the shell's
  // STUN probe and any public tracker stay unreachable); only a remote page needs the open one.
  const session = await live.launchBrowser({ headless: true, allowRemote: live.allowRemoteFor(url), profileDir, ignoreHTTPSErrors: isLoopbackUrl(url) });
  try {
    const page = await session.context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await live.acceptConsent(page, { timeoutMs: 15000 });
    const rendered = await live.renderWithRecovery(page, { consent: true, log });
    // The ledger is what matters here; a frame that does not render is reported, not fatal.
    if (!rendered.ok) warn('the site did not render (' + rendered.detail + '); reading the ledger anyway');
    log('waiting up to ' + waitSeconds + ' s for the ledger to sync');
    const deadline = Date.now() + waitSeconds * 1000;
    let last = -1;
    let stableSince = Date.now();
    let found = [];
    while (Date.now() < deadline) {
      found = await live.readLedgerBlocks(page);
      const here = live.pickLedgerDatabase(found, dbName);
      const count = here ? here.blocks.length : 0;
      if (count !== last) {
        last = count;
        stableSince = Date.now();
      } else if (count > 0 && Date.now() - stableSince > 5000) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const pick = live.pickLedgerDatabase(found, dbName);
    if (!pick) throw new ToolError('the site holds no ledger database' + (dbName ? ' ' + dbName : '') + ' (does it use the ledger?)');
    log('read ' + pick.blocks.length + ' blocks from ' + pick.database + (pick.checkpoint ? ' (pruned to checkpoint ' + pick.checkpoint.h.slice(0, 16) + '...)' : ''));
    // A pruned copy: the checkpoint goes first, as in ChainNode.exportSnapshot, so loadLedger starts from S.
    return pick.checkpoint ? [{ mw: 'checkpoint-v1', checkpoint: pick.checkpoint }].concat(pick.blocks) : pick.blocks;
  } finally {
    await session.close();
  }
}

async function loadInput(input, { remote, waitSeconds, profileDir, log }) {
  if (!/^https?:\/\//i.test(input)) {
    try {
      return readBlocksFile(input);
    } catch (err) {
      if (err instanceof ToolError) throw err;
      throw new ToolError('cannot read ' + input + ': ' + err.message);
    }
  }
  if (!isLoopbackUrl(input) && !remote) {
    throw new ToolError('refusing to contact ' + input + ': this tool then reaches the internet. Pass --remote to allow it (docs/DEV-NETWORK.md), or download the export and pass the file.');
  }
  log('GET ' + input + (isLoopbackUrl(input) ? '' : ' (remote: --remote)'));
  let res;
  try {
    res = await fetch(input, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
  } catch (err) {
    throw new ToolError('cannot fetch ' + input + ': ' + ((err && err.message) || err));
  }
  if (res.status !== 200) throw new ToolError(input + ' answered HTTP ' + res.status);
  const bytes = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get('content-type') || '';
  const head = bytes.subarray(0, 64).toString('utf8').trimStart();
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return parseExport(bytes, input);
  if (head.startsWith('[') || head.startsWith('{')) return parseExport(bytes, input);
  if (/html/i.test(type) || /^<!doctype|^<html/i.test(head)) return exportFromLiveSite(input, bytes.toString('utf8'), { waitSeconds, profileDir, log });
  throw new ToolError(input + ' is neither a ledger export nor a web page (content-type ' + (type || 'missing') + ')');
}

async function main(argv) {
  const { flags, positionals } = parseCli(argv, {
    out: { type: 'string' },
    'recent-out': { type: 'string' },
    posts: { type: 'int', default: RECENT_POSTS },
    plain: { type: 'boolean' },
    'genesis-owner': { type: 'string' },
    gen: { type: 'string' },
    'max-bytes': { type: 'int', default: CONFIG.ledger.snapshotMaxBytes },
    remote: { type: 'boolean' },
    wait: { type: 'int', default: 30 },
    profile: { type: 'string' },
    quiet: { type: 'boolean' },
  });
  if (flags.help) {
    out(USAGE.trim());
    return 0;
  }
  if (positionals.length !== 1) throw new UsageError('expected one input: an export file or a URL');
  if (!flags.out && !flags.recentOut) throw new UsageError('--out <file> is required (or --recent-out <file>)');
  const log = flags.quiet ? () => {} : out;
  const blocks = await loadInput(positionals[0], { remote: flags.remote, waitSeconds: flags.wait, profileDir: flags.profile, log });
  if (flags.recentOut) {
    const rec = await buildRecentSnapshot({ blocks, posts: flags.posts, genesisOwner: flags.genesisOwner, gen: flags.gen, maxBytes: flags.maxBytes });
    const data = encodeSnapshot(rec.entries, { plain: flags.plain });
    writeFileAtomic(flags.recentOut, data);
    log('recent   ' + rec.height + ' blocks (' + formatBytes(rec.bytes) + '), newest ' + rec.window.posts + ' posts' +
      (rec.checkpoint ? ', checkpoint ' + rec.checkpoint.h.slice(0, 16) + '...' : '') + (rec.window.truncated ? ', truncated' : ''));
    log('wrote    ' + flags.recentOut + ' (' + formatBytes(data.length) + (flags.plain ? ', plain JSON' : ', gzip') + ')');
    if (!flags.out) return 0;
  }
  const snap = await buildSnapshot({ blocks, genesisOwner: flags.genesisOwner, gen: flags.gen, maxBytes: flags.maxBytes });
  if (snap.invalid.length) warn(snap.invalid.length + ' invalid block(s) left out (first: ' + snap.invalid[0].reason + ')');
  if (snap.orphans) warn(snap.orphans + ' block(s) without their parents left out');
  const data = encodeSnapshot(snap.entries, { plain: flags.plain });
  writeFileAtomic(flags.out, data);
  const summary = stateSnapshot(snap.state, { now: Date.now() });
  log('ledger   ' + snap.site);
  log('blocks   ' + snap.height + ' (' + formatBytes(snap.bytes) + ' of blocks), root ' + snap.root.slice(0, 16) + '...');
  log('state    writers=' + summary.policy.writers + ', ' + Object.keys(summary.lists).length + ' list(s), ' + Object.keys(summary.kv).length + ' key(s), ' +
    snap.tombstoned + ' tombstoned, ' + snap.redacted + ' value(s) removed from the file');
  log('wrote    ' + flags.out + ' (' + formatBytes(data.length) + (flags.plain ? ', plain JSON' : ', gzip') + ')');
  // Post-wave fix E: since code review round 1 (F20, src/common/inflate.js) every loader at the browser floor reads
  // gzip; --plain is a choice (a .json name, a host that compresses JSON itself), not a requirement.
  log('Next: upload it to the cs= URL of your pointer (any static host; every loader reads ' +
    (flags.plain ? 'plain JSON' : 'the gzip file, also Safari and iOS 15.4 to 16.3 without DecompressionStream; --plain writes plain JSON if you prefer') + ').');
  if (!flags.plain && /\.json$/i.test(flags.out)) warn(flags.out + ' ends in .json but holds gzip: name it .json.gz, or use --plain');
  return 0;
}

if (isMain(import.meta.url)) runMain(main, USAGE);
