// pack-sketch.mjs - reference for `mw pack`: deterministic torrent + staged tree + release.json from a build directory.
// Rules learned in E1: explicit file list (directory mode drops dot-entries and trusts readdir order), byte-wise sort,
// creationDate pinned and > 0, announce: [] (no baked-in trackers), fixed name + piece length, nothing wall-clock in release.json.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const MODS = process.env.MW_MODULES || '$HOME/Documents/Projects/magnet-web/node_modules';
const { default: createTorrent } = await import(pathToFileURL(`${MODS}/create-torrent/index.js`).href);
const { default: parseTorrent } = await import(pathToFileURL(`${MODS}/parse-torrent/index.js`).href);

// host config and OS junk are NOT site content; .well-known and other dot-paths ARE (an allow/deny list, not a blanket dotfile rule)
export const DEFAULT_IGNORE = [/(^|\/)\.DS_Store$/, /(^|\/)Thumbs\.db$/, /(^|\/)\.git(\/|$)/, /^(_headers|_redirects|\.htaccess|netlify\.toml|vercel\.json)$/];

function walk(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(dir, r)); else if (e.isFile()) out.push(r);   // symlinks and specials are skipped on purpose
  }
  return out;
}
const byBytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));            // UTF-8 byte order, not UTF-16 code-unit order
const sha256 = s => createHash('sha256').update(s).digest('hex');

export async function pack(dir, { name, pieceLength = 262144, created, version, ignore = DEFAULT_IGNORE, outDir }) {
  if (!name) throw new Error('name is required (it is part of the infohash)');
  if (!(Number.isInteger(created) && created > 0)) throw new Error('created must be a positive unix-seconds integer (new Date(0) is falsy in create-torrent and silently becomes "now")');
  const rels = walk(dir).filter(r => !ignore.some(rx => rx.test(r))).sort(byBytes);
  if (!rels.length) throw new Error('no files to pack');
  const blobs = [];
  for (const r of rels) { const b = await fs.openAsBlob(path.join(dir, r)); b.fullPath = `${name}/${r}`; blobs.push(b); }
  const buf = await new Promise((res, rej) => createTorrent(blobs, { name, pieceLength, announce: [], creationDate: new Date(created * 1000) }, (e, x) => e ? rej(e) : res(x)));
  const t = await parseTorrent(buf);
  const files = t.files.map(f => ({ path: f.path.slice(name.length + 1), length: f.length }));
  const release = {
    v: 1, rel: `${version}-${t.infoHash.slice(0, 8)}`, version, btih: t.infoHash, name, pieceLength,
    files: files.length, bytes: files.reduce((n, f) => n + f.length, 0),
    manifestSha256: sha256(files.map(f => `${f.path}\0${f.length}`).join('\n')), created,
  };
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'site.torrent'), buf);
    fs.writeFileSync(path.join(outDir, 'release.json'), JSON.stringify(release, null, 2) + '\n');
    for (const r of rels) { const to = path.join(outDir, 'tree', r); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(dir, r), to); }   // upload THIS tree, so seed objects == torrent payload
  }
  return { buf, release, files: rels };
}
