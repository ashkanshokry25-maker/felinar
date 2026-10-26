import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pack } from './pack-sketch.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mwe7-'));
const files = { 'index.html': '<!doctype html><title>x</title>\n', 'about.html': 'a\n', 'css/app.css': 'body{}\n', 'js/app.js': '1\n', 'img/p.png': Buffer.alloc(300000, 3),
  '.well-known/security.txt': 'Contact: x\n', 'café/é.html': 'e\n', '\u{1F600}.txt': 'emoji\n', '_headers': '/*\n', '.htaccess': 'x\n', '.DS_Store': 'junk', 'Zeta.txt': 'z\n', 'alpha.txt': 'a\n' };
function make(dir, order, t0) { let i = 0; for (const rel of order) { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, files[rel]); fs.utimesSync(p, new Date(t0 + 1000 * i), new Date(t0 + 1000 * i)); fs.chmodSync(p, i % 2 ? 0o600 : 0o644); i++; } }
const names = Object.keys(files);
const A = path.join(root, 'one', 'dist'), B = path.join(root, 'two', 'elsewhere', 'dist');
make(A, names, Date.parse('2026-01-01')); make(B, [...names].reverse(), Date.parse('2026-09-09'));
const opts = { name: 'site', pieceLength: 262144, created: 1792195200, version: '1.4.2' };
const ra = await pack(A, { ...opts, outDir: path.join(root, 'outA') });
const rb = await pack(B, { ...opts, outDir: path.join(root, 'outB') });
const same = (f) => Buffer.compare(fs.readFileSync(path.join(root, 'outA', f)), fs.readFileSync(path.join(root, 'outB', f))) === 0;
console.log('release.json identical:', same('release.json'), '| site.torrent bytes identical:', same('site.torrent'), '| btih', ra.release.btih, '| rel', ra.release.rel);
console.log('packed files:', ra.files.join(', '));
console.log('excluded (junk/host config):', ['.DS_Store', '_headers', '.htaccess'].filter(f => !ra.files.includes(f)).join(', '), '| included dot-path:', ra.files.filter(f => f.startsWith('.')).join(', '));
const walkT = (d, r = '') => fs.readdirSync(path.join(d, r), { withFileTypes: true }).flatMap(e => e.isDirectory() ? walkT(d, r ? `${r}/${e.name}` : e.name) : [r ? `${r}/${e.name}` : e.name]);
const staged = walkT(path.join(root, 'outA', 'tree')).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
console.log('staged tree == torrent file list:', JSON.stringify(staged) === JSON.stringify(ra.files), '| sort check (UTF-8 byte order):', ra.files.join(' | '));
for (const bad of [{ ...opts, created: 0 }, { ...opts, name: '' }]) { try { await pack(A, bad); console.log('UNEXPECTED: accepted', JSON.stringify(bad)); } catch (e) { console.log('rejects bad input ->', e.message.slice(0, 70)); } }
fs.rmSync(root, { recursive: true, force: true });
